#!/usr/bin/env node
/**
 * Exhaustive interleaving exploration of the REAL code for trusted per-job
 * Code Mode Off (stateless model checking by re-execution). NOT a TLC model check.
 *
 * Real code: dsh-cron lib/agent-task.js (+ executor.js, security.js) and
 * dsh-codemode run-policy.mjs + selection.mjs. Seams: host packages (as in
 * test/security.test.js), the native agent factory (prepare Session -> setup ->
 * publish, each a separately ordered step, mirroring dsh-agent-loop
 * createAgent/initializeAgent), the Code Mode storage table (every put is a
 * deferred commit) and the plugin wiring (createSelection({boundOff:offFor}) +
 * provide/dispose, as plugin.mjs does; plugin.mjs itself is covered by the
 * Code Mode suite and production-archive proof, not here).
 *
 * Promise: an ordinary session (create/claim/reclaim/adopt by id, or a
 * selection change) can neither GAIN nor LOSE the owner's per-job Off:
 *  G1 another Session object under the run's id never reads Off because of the
 *     run (it reads Off only if its own saved record is Off);
 *  G2 no one but the runner's admission ever submits through admitInitialOff;
 *  L1 an Off job's first prompt is submitted only while: the binding is on the
 *     exact runner-created object, the service is live, the committed saved
 *     record is not On, and no On request was issued before admission began;
 *  L2 after Agent publication, an unsaved runner-created Session never reads On;
 *  L3 an Off job with no/disposed service never submits a prompt.
 * Default jobs are a witness: they submit without touching the service.
 *
 * Usage: node explore.mjs --cron-lib <dir> --codemode <dir> [--scenario name|all] [--json]
 * Exit 0 = held in every explored schedule and all witnesses reached;
 * 1 = violation (shortest counterexample printed) or vacuity; 2 = error.
 */
import path from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const cronLib = path.resolve(opt("--cron-lib", path.join(here, "../../lib")));
const codemodeDir = opt("--codemode", process.env.CODEMODE_PLUGIN_DIR);
if (!codemodeDir) { console.error("--codemode <dsh-codemode plugin dir> (or CODEMODE_PLUGIN_DIR) required"); process.exit(2); }
const which = opt("--scenario", "all");
const asJson = argv.includes("--json");
const MAX_SCHEDULES = Number(opt("--max-schedules", "200000"));

const stubs = {
	"@deepseek-ai/dsh-tools": "export const defineTool = x => x;",
	"@deepseek-ai/dsh-agent": "export const installModelSelection = () => {};",
	"@deepseek-ai/dsh-llm": "export const ReasoningEffortId = x => x; export const createUserMessage = x => x;",
	"@deepseek-ai/dsh-session": "export const SessionId = x => x;",
	"@deepseek-ai/dsh-storage-domain": "export const defineDomain = x => x; export const domainTable = x => x;",
	"zod": "const any = new Proxy(function(){}, { get: () => any, apply: () => any }); export const z = any; export default any;",
};
registerHooks({ resolve(specifier, context, next) {
	if (stubs[specifier]) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
	return next(specifier, context);
} });
const { runAgentTask } = await import(pathToFileURL(path.join(cronLib, "agent-task.js")).href);
const { normalizeJobs } = await import(pathToFileURL(path.join(cronLib, "service.js")).href);
const { createRunPolicy } = await import(pathToFileURL(path.resolve(codemodeDir, "run-policy.mjs")).href);
const { createSelection } = await import(pathToFileURL(path.resolve(codemodeDir, "selection.mjs")).href);

/**
 * Scenarios (bounded). defaultOn:true everywhere so Off is never the ambient default.
 * actors: runner(id, codeMode, setupFails?) | claim(id) new object | adopt(id) same live object
 *         | on(id) human/Remote set On | dispose | retry(id) second runner after the first settles.
 */
const SCENARIOS = {
	"pending-claim-permit": { backend: "permit", actors: [["runner", "P", "off"], ["claim", "P"]] },
	"pending-claim-reject": { backend: "reject", actors: [["runner", "P", "off"], ["claim", "P"]] },
	"blank-adopt": { backend: "reject", actors: [["runner", "P", "off"], ["adopt", "P"]] },
	"on-vs-admission": { backend: "reject", actors: [["runner", "P", "off"], ["on", "P"]] },
	"unload-race": { backend: "reject", actors: [["runner", "P", "off"], ["dispose"]] },
	"boot-not-ready": { backend: "reject", service: false, actors: [["runner", "P", "off"], ["claim", "P"]] },
	"setup-fail-retry": { backend: "permit", actors: [["runner", "P", "off", true], ["claim", "P"], ["retry", "Q", "off"]] },
	// Two Off runs at once: no cross-run binding/admission leak. (Adding a third actor exceeds the
	// 200k schedule bound; claim races are covered by the two-actor scenarios above.)
	"concurrent-runs": { backend: "permit", actors: [["runner", "P", "off"], ["runner", "Q", "off"]] },
	"default-job": { backend: "permit", actors: [["runner", "P", "default"], ["claim", "P"]] },
	// Host default Off: a claimant reads Off legitimately; checks that admission still refuses it.
	"claim-default-off": { backend: "permit", defaultOn: false, actors: [["runner", "P", "off"], ["claim", "P"]] },
};

const drain = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };

async function execute(scenario, prefix) {
	const ops = [], log = [], choices = [];
	let violation = null;
	const events = { offSubmitted: 0, defaultSubmitted: 0, runFailed: 0, claimReadOn: 0, claimReadOff: 0, adoptRead: 0, onRefused: 0, disposeRefused: 0, collision: 0, serviceTouchedByDefault: 0, claimAdmitRefused: 0 };
	const fail = (rule, text) => { if (violation === null) { log.push(`VIOLATION ${rule}: ${text}`); violation = log.length; } };
	const defer = (label, fn) => new Promise((resolve, reject) => ops.push({ label, fire: () => { try { resolve(fn()); } catch (e) { reject(e); } } }));

	// Code Mode storage: committed map; every put is a deferred commit.
	const committed = new Map();
	const table = { get: (k) => committed.get(k), put: (k, v) => defer(`storage commits codemode put(${k} enabled=${v.enabled})`, () => { committed.set(k, v); }) };
	const facility = { open: async () => ({ table: () => table, close: async () => {} }) };
	const run = createRunPolicy();
	const selection = createSelection({ get: (n) => (n === "storageDomain" ? facility : undefined) }, { defaultOn: scenario.defaultOn !== false, boundOff: run.offFor });
	let svc = scenario.service === false ? undefined : run.service(selection);
	let disposed = false;
	const onRequested = new Map(); // id -> log index of first On request
	const runnerObjects = new Map(); // id -> Session object created by a runner's factory call
	const published = new Set(); // runner Session objects whose Agent is published
	const liveSessions = new Map(); // id -> live Session object (host session store)

	// Native factory seam: prepare (collision check) -> setup(agentCtx, agent) -> publish.
	function factory(who, withRunnerSetup) {
		return async (options) => {
			const id = options.sessionId;
			const session = await defer(`${who}: host prepares a fresh Session object for ${id}`, () => {
				if (liveSessions.has(id) && scenario.backend === "reject") { events.collision++; log.push(`${who}: host refuses ${id} (live collision)`); throw new Error(`session ${id} collision`); }
				const s = { id, seq: 0, events: [], tag: `${who}-object` };
				liveSessions.set(id, s);
				log.push(`${who}: Session ${id} announced (${s.tag})${scenario.backend === "permit" ? " [backend permits same-id instance]" : ""}`);
				return s;
			});
			const agent = { id, session, followup: null, whenIdle: withRunnerSetup ? () => defer(`${who}: Agent ${id} reaches idle`, () => {}) : async () => {} };
			if (withRunnerSetup) {
				runnerObjects.set(id, session);
				await defer(`${who}: native setup(agentCtx, agent) runs for ${id}`, () => {});
				await options.setup({ get: () => undefined }, agent);
			}
			await defer(`${who}: Agent ${id} published`, () => {});
			if (withRunnerSetup) published.add(session);
			return { agent, dispose: async () => { if (liveSessions.get(id) === session) liveSessions.delete(id); } };
		};
	}
	function effectiveFromCommitted(id) { const r = committed.get(id); return r === undefined ? undefined : r.enabled; }

	function runner(who, id, codeMode, setupFails) {
		const job = normalizeJobs([{ name: `job-${id}`, schedule: { everySeconds: 3600 }, task: { kind: "agent", prompt: "go", timeoutSeconds: 60, ...(codeMode === "off" ? { codeMode: "off" } : {}) } }])[0];
		let admissionStartedAt = -1;
		const ctx = {
			logger: { info() {}, warn() {}, error() {} },
			get: (n) => {
				if (n === "codemodeRunPolicy") {
					if (codeMode !== "off") events.serviceTouchedByDefault++;
					if (svc === undefined || disposed) return undefined;
					// Observe the admission request time without changing behavior.
					return { bindCreatedSession: (a, p) => svc.bindCreatedSession(a, p), admitInitialOff: (a, cb) => { admissionStartedAt = log.length; log.push(`${who}: requests admitInitialOff for ${id}`); return svc.admitInitialOff(a, cb); } };
				}
				if (n === "agentPresets") return { mount: async () => { if (setupFails) throw new Error("preset mount failed"); } };
				return undefined;
			},
			agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) },
			sessions: { flush: async () => {} },
			agents: { create: async (options) => {
				const handle = await factory(who, true)(options);
				handle.agent.followup = () => {
					const s = handle.agent.session;
					log.push(`${who}: first prompt submitted on ${id}${codeMode === "off" ? " (Off job)" : ""}`);
					if (codeMode !== "off") { events.defaultSubmitted++; return; }
					events.offSubmitted++;
					if (svc === undefined) fail("L3", "Off job submitted with no Code Mode service");
					if (disposed) fail("L3", "Off job submitted after Code Mode service disposal");
					if (s !== runnerObjects.get(id) || !run.offFor({ id, session: s })) fail("L1", "submitted without a live exact-object binding");
					if (effectiveFromCommitted(id) === true) fail("L1", "submitted while the committed saved choice is On (effective On)");
					if (onRequested.has(id) && onRequested.get(id) < admissionStartedAt) fail("L1", "submitted although an On request was issued before admission began");
					if (admissionStartedAt < 0) fail("L1", "Off job submitted without admission");
				};
				return handle;
			} },
		};
		return () => runAgentTask(ctx, job, new Date(0).toISOString(), undefined, id, 1).then(
			(out) => { if (out.status !== "ok") { events.runFailed++; log.push(`${who}: run settles ${out.status}`); } else log.push(`${who}: run settles ok`); },
			(error) => { events.runFailed++; log.push(`${who}: run fails before prompt: ${String(error.message ?? error).slice(0, 90)}`); },
		);
	}
	async function readAs(who, agent, isRunnerObject) {
		let enabled;
		try { enabled = await selection.status(agent); } catch (e) { log.push(`${who}: status read fails (${e.message})`); return; }
		log.push(`${who}: reads effective Code Mode ${enabled ? "On" : "Off"} for ${agent.id}`);
		const saved = effectiveFromCommitted(agent.id);
		if (!isRunnerObject) {
			enabled ? events.claimReadOn++ : events.claimReadOff++;
			if (!enabled && saved !== false && !disposed && scenario.defaultOn !== false) fail("G1", "a non-runner object under the run id reads Off without its own saved Off");
		} else {
			events.adoptRead++;
			if (enabled && saved === undefined && published.has(agent.session) && !disposed) fail("L2", "the runner-created Session reads On (unsaved) after Agent publication");
		}
	}
	function claim(who, id) {
		return async () => {
			let handle;
			try { handle = await factory(who, false)({ sessionId: id }); } catch { log.push(`${who}: ordinary create refused`); return; }
			const agent = handle.agent;
			await readAs(who, agent, agent.session === runnerObjects.get(id));
			if (svc !== undefined) {
				let ran = false;
				try { await svc.admitInitialOff(agent, () => { ran = true; }); } catch { events.claimAdmitRefused++; }
				if (ran) fail("G2", "an ordinary claimant's prompt passed the runner admission");
			}
		};
	}
	function adopt(who, id) {
		return async () => {
			const existing = liveSessions.get(id);
			if (existing === undefined) { log.push(`${who}: nothing live to adopt`); return; }
			log.push(`${who}: ordinary request adopts the live Session ${id} (${existing.tag})`);
			await readAs(who, { id, session: existing }, existing === runnerObjects.get(id));
		};
	}
	function on(who, id) {
		return () => {
			if (!onRequested.has(id)) onRequested.set(id, log.length);
			log.push(`${who}: requests saved On for ${id}`);
			return selection.set({ id }, true).then(() => log.push(`${who}: saved On for ${id} answered`), (e) => log.push(`${who}: set On refused (${e.message})`));
		};
	}

	const retries = [];
	let firstRunnerDone = null;
	scenario.actors.forEach(([kind, id, mode, extra], i) => {
		const who = `${kind}${i + 1}`;
		if (kind === "retry") { retries.push({ label: `cron ${who}: retry launches with a NEW minted id ${id}`, fire: () => { runner(who, id, mode, false)(); } }); return; }
		const start = kind === "runner" ? runner(who, id, mode, extra) : kind === "claim" ? claim(who, id) : kind === "adopt" ? adopt(who, id) : kind === "on" ? on(who, id) : null;
		const label = kind === "runner" ? `cron ${who}: launch records ${id} and starts the ${mode} run` : kind === "dispose" ? `${who}: Code Mode plugin unloads (service disposed)` : `${who}: ${kind === "claim" ? `ordinary session.create({sessionId:${id}})` : kind === "adopt" ? `ordinary request for live ${id}` : `Remote/human set On for ${id}`} starts`;
		ops.push({ label, fire: () => {
			if (kind === "dispose") { disposed = true; run.close(); void selection.close(); svc = svc; events.disposeRefused += 0; return; }
			const p = start();
			if (kind === "runner" && firstRunnerDone === null) firstRunnerDone = p.then(() => { for (const r of retries) ops.push(r); });
		} });
	});

	let step = 0;
	for (;;) {
		await drain();
		if (ops.length === 0) break;
		const chosen = step < prefix.length ? prefix[step] : 0;
		choices.push({ chosen, enabled: ops.length });
		const [op] = ops.splice(chosen, 1);
		log.push(op.label);
		op.fire();
		step += 1;
		if (step > 200) throw new Error("step bound exceeded");
	}
	await drain();
	// Refusals observed in the log (witnesses only).
	if (log.some((l) => /saved On/.test(l) && /fails before prompt/.test(l))) events.onRefused++;
	if (log.some((l) => /disposed|unavailable/.test(l) && /fails before prompt/.test(l))) events.disposeRefused++;
	return { choices, log, violation, events };
}

async function explore(name, scenario) {
	let prefix = [], schedules = 0, shortest = null, maxDepth = 0, truncated = false;
	const reached = {};
	for (;;) {
		const r = await execute(scenario, prefix);
		schedules += 1;
		maxDepth = Math.max(maxDepth, r.choices.length);
		for (const [k, v] of Object.entries(r.events)) reached[k] = (reached[k] ?? 0) + (v > 0 ? 1 : 0);
		if (r.violation !== null) { const trace = r.log.slice(0, r.violation); if (shortest === null || trace.length < shortest.length) shortest = trace; }
		let i = r.choices.length - 1;
		while (i >= 0 && r.choices[i].chosen + 1 >= r.choices[i].enabled) i -= 1;
		if (i < 0) break;
		prefix = r.choices.slice(0, i).map((c) => c.chosen);
		prefix.push(r.choices[i].chosen + 1);
		if (schedules >= MAX_SCHEDULES) { truncated = true; break; }
	}
	return { name, schedules, maxDepth, truncated, shortest, reached };
}

/** Witnesses each scenario must reach in at least one schedule (non-vacuity). */
const WITNESS = {
	"pending-claim-permit": ["offSubmitted", "claimReadOn", "claimAdmitRefused"],
	"pending-claim-reject": ["offSubmitted", "collision", "runFailed", "claimReadOn"],
	"blank-adopt": ["offSubmitted", "adoptRead"],
	"on-vs-admission": ["offSubmitted", "onRefused"],
	"unload-race": ["offSubmitted", "disposeRefused"],
	"boot-not-ready": ["runFailed", "disposeRefused", "claimReadOn"],
	"setup-fail-retry": ["runFailed", "offSubmitted", "claimReadOn"],
	"concurrent-runs": ["offSubmitted"],
	"default-job": ["defaultSubmitted", "claimReadOn"],
	"claim-default-off": ["offSubmitted", "claimReadOff", "claimAdmitRefused"],
};
const FORBIDDEN_WITNESS = { "default-job": ["serviceTouchedByDefault", "offSubmitted"], "boot-not-ready": ["offSubmitted"] };

const names = which === "all" ? Object.keys(SCENARIOS) : [which];
let failed = false;
const results = [];
const t0 = Date.now();
for (const name of names) {
	const scenario = SCENARIOS[name];
	if (!scenario) { console.error(`unknown scenario ${name}`); process.exit(2); }
	const res = await explore(name, scenario);
	results.push(res);
	const vacuous = (WITNESS[name] ?? []).filter((k) => !res.reached[k]);
	const forbidden = (FORBIDDEN_WITNESS[name] ?? []).filter((k) => res.reached[k]);
	const bad = res.shortest !== null || res.truncated || vacuous.length > 0 || forbidden.length > 0;
	failed ||= bad;
	if (asJson) continue;
	console.log(`\n== scenario ${name} (backend=${scenario.backend}${scenario.service === false ? ", no Code Mode service" : ""}; actors=${scenario.actors.map((a) => a.filter((x) => x !== undefined).join(":")).join(" + ")})`);
	console.log(`   schedules explored: ${res.schedules}${res.truncated ? " (TRUNCATED at bound)" : " (exhaustive)"}; max steps per schedule: ${res.maxDepth}`);
	console.log(`   witnesses (schedules reaching each event): ${JSON.stringify(res.reached)}`);
	if (vacuous.length) console.log(`   VACUITY: expected events never reached: ${vacuous.join(", ")}`);
	if (forbidden.length) console.log(`   FORBIDDEN events reached: ${forbidden.join(", ")}`);
	if (res.shortest !== null) {
		console.log(`   VIOLATION; shortest counterexample (${res.shortest.length} steps):`);
		res.shortest.forEach((s, i) => console.log(`     ${i + 1}. ${s}`));
	} else console.log("   no-gain/no-loss held in every schedule");
}
if (asJson) console.log(JSON.stringify(results, null, 1));
console.log(`\ncron lib: ${cronLib}\ncodemode: ${path.resolve(codemodeDir)}\nresult: ${failed ? "FAIL" : "PASS"} (${Date.now() - t0} ms)`);
process.exit(failed ? 1 : 0);
