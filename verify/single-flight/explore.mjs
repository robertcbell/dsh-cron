#!/usr/bin/env node
/**
 * Exhaustive interleaving exploration of the REAL lib/service.js
 * (stateless model checking by re-execution). NOT a TLC model check.
 *
 * Rule: one cron job has at most one run whose task is executing at a time.
 *
 * Every storage write the service awaits is a deferred step the explorer
 * commits in a chosen order; every task run finishes only when the explorer
 * chooses; every actor (runNow / scheduled dispatch) starts when chosen.
 * Between choices all microtasks drain, so one choice = one atomic step of
 * the real code between two awaits (Node's run-to-completion model).
 * DFS enumerates every choice sequence up to the bound; the shortest
 * violating sequence is printed as numbered plain-language steps.
 *
 * Usage: node explore.mjs [--lib <dir>] [--scenario <name>|all] [--json]
 * Exit 0 = rule held in every explored schedule AND non-vacuity witnesses
 * were reached; 1 = violation (counterexample printed) or vacuity; 2 = error.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : dflt;
};
const libDir = path.resolve(opt("--lib", path.join(here, "../../lib")));
const which = opt("--scenario", "all");
const asJson = argv.includes("--json");
const MAX_SCHEDULES = Number(opt("--max-schedules", "200000"));

const { CronService, normalizeJobs, PLUGIN_NORMALIZE } = await import(pathToFileURL(path.join(libDir, "service.js")).href);

/** Bounded scenarios: actors started by the explorer at chosen points. */
const SCENARIOS = {
	// Double click / two concurrent cron_run_now calls.
	"runNow-x2": { overlap: "skip", actors: ["runNow", "runNow"] },
	// Scheduled occurrence racing a manual run, overlap skip.
	"runNow+tick-skip": { overlap: "skip", actors: ["runNow", "tick"] },
	// Same with overlap queue (pending relaunch on settle).
	"runNow+tick-queue": { overlap: "queue", actors: ["runNow", "tick", "tick"] },
	// Three manual requests: opt-in only (--scenario runNow-x3); its space
	// exceeds the default schedule bound, so it reports TRUNCATED.
	"runNow-x3": { overlap: "skip", actors: ["runNow", "runNow", "runNow"], optIn: true },
};

const drain = async () => {
	await new Promise((r) => setImmediate(r));
	await new Promise((r) => setImmediate(r));
};

/** One execution following `prefix` choices, then choice 0. */
async function execute(scenario, prefix) {
	const ops = []; // enabled steps: {label, fire}
	const log = []; // plain-language steps taken
	const choices = []; // {chosen, enabled}
	let executing = 0;
	let maxExecuting = 0;
	let violationAt = -1;
	const events = { started: 0, finished: 0, refused: 0, skipped: 0, parked: 0, dispatchLaunch: 0, runNowLaunch: 0 };

	function deferredTable(tname) {
		const map = new Map();
		const defer = (what, apply) => new Promise((resolve) => {
			ops.push({ label: `storage commits ${tname}.${what}`, fire: () => resolve(apply()) });
		});
		return {
			map,
			get: (k) => map.get(k),
			put: (k, v) => defer(`put(${k}${v?.status ? ` status=${v.status}` : ""})`, () => (map.set(k, v), v)),
			update: (k, fn) => defer(`update(${k})`, () => {
				const n = fn(map.get(k));
				map.set(k, n);
				return n;
			}),
			delete: (k) => defer(`delete(${k})`, () => void map.delete(k)),
			keys: () => map.keys(),
			entries: () => map.entries(),
		};
	}

	const tables = { runs: deferredTable("runs"), jobs: deferredTable("jobs"), manual: deferredTable("manual"), plugin: deferredTable("plugin") };
	const handler = ({ seq }) => {
		executing += 1;
		events.started += 1;
		if (executing > maxExecuting) maxExecuting = executing;
		log.push(`run #${seq} task starts executing (now ${executing} executing)`);
		if (executing > 1 && violationAt < 0) violationAt = log.length;
		return new Promise((resolve) => {
			ops.push({
				label: `run #${seq} task finishes`,
				fire: () => {
					executing -= 1;
					events.finished += 1;
					resolve("ok");
				},
			});
		});
	};
	const jobs = normalizeJobs([{
		name: "job",
		schedule: { everySeconds: 3600 },
		task: { kind: "callback", timeoutSeconds: 3600 },
		policy: { overlap: scenario.overlap, misfire: "skip" },
	}], PLUGIN_NORMALIZE);
	jobs[0].handler = handler;
	const ctx = { logger: { info() {}, warn() {}, error() {} } };
	const service = new CronService(ctx, { historyLimit: 50, maxConcurrentRuns: 0 }, jobs, { enabled: false, root: "/nonexistent", graceMs: 1 });
	service.domain = { table: (n) => tables[n], close: async () => {} };
	tables.jobs.map.set("job", { anchorMs: 0, lastFiredMs: 0, runSeq: 0 });
	service.floor.set("job", 0);

	// Instrument the real decision points (observation only, no behavior change).
	const origLaunch = service.launch.bind(service);
	service.launch = (job, targetMs, seq, manual = false) => {
		if (manual) events.runNowLaunch += 1;
		else events.dispatchLaunch += 1;
		log.push(`service.launch(run #${seq}${manual ? ", manual" : ", scheduled"}) sets running entry`);
		return origLaunch(job, targetMs, seq, manual);
	};
	const origSkip = service.recordSkipped.bind(service);
	service.recordSkipped = (job, t, seq) => {
		events.skipped += 1;
		log.push(`dispatch sees a run in flight: occurrence #${seq} recorded skipped-overlap`);
		return origSkip(job, t, seq);
	};

	// runNow actors are independent (each tool call / HTTP request is its own
	// async task). Scheduled ticks are serialized like the real loop(), which
	// awaits dispatch() before looking for the next due occurrence: tick k+1
	// becomes enabled only after dispatch for tick k resolved.
	const ticks = [];
	let tickN = 0;
	const enableNextTick = () => {
		const next = ticks.shift();
		if (next !== undefined) ops.push(next);
	};
	scenario.actors.forEach((kind, i) => {
		const who = `${kind}${i + 1}`;
		if (kind === "runNow") {
			ops.push({
				label: `user request ${who}: cron_run_now(job)`,
				fire: () => {
					service.runNow("job").then((out) => {
						if (out?.code === "already_running") {
							events.refused += 1;
							log.push(`${who} answered already_running (refused)`);
						} else log.push(`${who} answered started seq=${out?.seq}`);
					});
				},
			});
		} else {
			ticks.push({
				label: `scheduler ${who}: due occurrence -> dispatch(job)`,
				fire: () => {
					tickN += 1;
					service.dispatch(jobs[0], 1000 * tickN).then(enableNextTick);
				},
			});
		}
	});
	enableNextTick();
	const origPendingSet = service.pending.set.bind(service.pending);
	service.pending.set = (k, v) => {
		events.parked += 1;
		log.push(`dispatch sees a run in flight: occurrence #${v.seq} parked (queue)`);
		return origPendingSet(k, v);
	};

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
	return { choices, log, maxExecuting, violationAt, events, lastFiredMs: tables.jobs.map.get("job").lastFiredMs };
}

async function explore(name, scenario) {
	let prefix = [];
	let schedules = 0;
	let shortest = null;
	let maxDepth = 0;
	const reached = { started: 0, finished: 0, refused: 0, skipped: 0, parked: 0, dispatchLaunch: 0, runNowLaunch: 0 };
	let allSchedulesFinishSomething = true;
	for (;;) {
		const r = await execute(scenario, prefix);
		schedules += 1;
		maxDepth = Math.max(maxDepth, r.choices.length);
		for (const k of Object.keys(reached)) reached[k] += r.events[k] > 0 ? 1 : 0;
		if (r.events.finished === 0) allSchedulesFinishSomething = false;
		if (r.violationAt >= 0) {
			const trace = r.log.slice(0, r.violationAt);
			if (shortest === null || trace.length < shortest.length) shortest = trace;
		}
		// Backtrack: deepest choice point with an untried alternative.
		let i = r.choices.length - 1;
		while (i >= 0 && r.choices[i].chosen + 1 >= r.choices[i].enabled) i -= 1;
		if (i < 0) break;
		prefix = r.choices.slice(0, i).map((c) => c.chosen);
		prefix.push(r.choices[i].chosen + 1);
		if (schedules >= MAX_SCHEDULES) return { name, scenario, schedules, maxDepth, truncated: true, shortest, reached, allSchedulesFinishSomething };
	}
	return { name, scenario, schedules, maxDepth, truncated: false, shortest, reached, allSchedulesFinishSomething };
}

const names = which === "all" ? Object.keys(SCENARIOS).filter((n) => !SCENARIOS[n].optIn) : [which];
let failed = false;
const results = [];
const t0 = Date.now();
for (const name of names) {
	const scenario = SCENARIOS[name];
	if (scenario === undefined) {
		console.error(`unknown scenario ${name}`);
		process.exit(2);
	}
	const res = await explore(name, scenario);
	results.push(res);
	const expectWitness = {
		started: true,
		finished: true,
		refused: scenario.actors.filter((a) => a === "runNow").length > 1 || scenario.actors.includes("tick"),
		skipped: scenario.overlap === "skip" && scenario.actors.includes("tick"),
		parked: scenario.overlap === "queue",
		dispatchLaunch: scenario.actors.includes("tick"),
		runNowLaunch: scenario.actors.includes("runNow"),
	};
	const vacuous = Object.entries(expectWitness).filter(([k, want]) => want && res.reached[k] === 0).map(([k]) => k);
	const bad = res.shortest !== null || res.truncated || vacuous.length > 0 || !res.allSchedulesFinishSomething;
	failed ||= bad;
	if (asJson) continue;
	console.log(`\n== scenario ${name} (overlap=${scenario.overlap}, actors=${scenario.actors.join("+")})`);
	console.log(`   schedules explored: ${res.schedules}${res.truncated ? " (TRUNCATED at bound)" : " (exhaustive)"}; max steps per schedule: ${res.maxDepth}`);
	console.log(`   witnesses (schedules reaching each event): ${JSON.stringify(res.reached)}`);
	console.log(`   every schedule finishes >=1 run: ${res.allSchedulesFinishSomething}`);
	if (vacuous.length > 0) console.log(`   VACUITY: expected events never reached: ${vacuous.join(", ")}`);
	if (res.shortest !== null) {
		console.log(`   VIOLATION of single-flight; shortest counterexample (${res.shortest.length} steps):`);
		res.shortest.forEach((s, i) => console.log(`     ${i + 1}. ${s}`));
	} else console.log("   single-flight held in every schedule");
}
if (asJson) console.log(JSON.stringify(results.map(({ scenario, ...r }) => r), null, 1));
console.log(`\nlib: ${libDir}\nresult: ${failed ? "FAIL" : "PASS"} (${Date.now() - t0} ms)`);
process.exit(failed ? 1 : 0);
