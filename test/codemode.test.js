/**
 * task.codeMode ("default" | "off") — trusted per-job initial Code Mode Off.
 * Real lib/agent-task.js and lib/service.js; host packages and the native agent
 * factory are seams. The factory calls setup(agentCtx, agent) with the EXACT
 * created Session the way dsh-agent-loop's initializeAgent does.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { specDigest, isManualJobApproved } from "../lib/security.js";
import { CronService, buildJobSpec, normalizeJobs } from "../lib/service.js";

const hostModules = {
	"@deepseek-ai/dsh-tools": "export const defineTool = x => x;",
	"@deepseek-ai/dsh-agent": "export const installModelSelection = () => {};",
	"@deepseek-ai/dsh-llm": "export const ReasoningEffortId = x => x; export const createUserMessage = x => x;",
	"@deepseek-ai/dsh-session": "export const SessionId = x => x;",
};
registerHooks({
	resolve(specifier, context, next) {
		if (hostModules[specifier]) return { url: `data:text/javascript,${encodeURIComponent(hostModules[specifier])}`, shortCircuit: true };
		if (specifier === "./domain.js") return { url: "data:text/javascript,export const cronDomain = {};", shortCircuit: true };
		return next(specifier, context);
	},
});
const { runAgentTask } = await import("../lib/agent-task.js");
const { registerCronTools } = await import("../lib/tools.js");
const base = { name: "nightly", schedule: { everySeconds: 3600 }, task: { kind: "agent", prompt: "report", timeoutSeconds: 5 } };
const job = (task = {}) => normalizeJobs([{ ...base, task: { ...base.task, ...task } }])[0];

/** A fake host whose native factory runs setup on the exact created Session, then publishes. */
function host({ policy, order = [], presets } = {}) {
	const made = [];
	const ctx = {
		logger: { info() {}, warn() {}, error() {} },
		get: (name) => name === "codemodeRunPolicy" ? policy : name === "agentPresets" ? presets : undefined,
		agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) },
		sessions: { flush: async () => {} },
		agents: {
			create: async (options) => {
				order.push("create");
				const session = { id: options.sessionId, seq: 0, events: [] };
				const agent = {
					id: options.sessionId, session,
					followup(message) { order.push("followup"); session.events.push({ seq: session.seq++, type: "turn/start" }); session.events.push({ seq: session.seq++, type: "turn/end", data: { reason: { kind: "done" } } }); this.sent = message; },
					whenIdle: async () => {},
				};
				made.push(agent);
				await options.setup({ get: () => undefined }, agent);
				order.push("published");
				return { agent, dispose: async () => { order.push("dispose"); } };
			},
		},
	};
	return { ctx, made, order };
}
/** Minimal faithful stand-in for dsh-codemode 0.12.0's run-policy service contract. */
function policyService({ saved } = {}) {
	const bound = new WeakMap(), calls = [];
	return {
		calls,
		bindCreatedSession(agent, policy) { calls.push(["bind", agent.session, policy]); if (bound.has(agent.session)) throw Error("already bound"); bound.set(agent.session, policy); return true; },
		async admitInitialOff(agent, submit) { calls.push(["admit", agent.session]); if (!bound.get(agent.session)?.initialOff) throw Error("no exact creation binding"); if (saved === true) throw Error("saved On"); return submit(); },
	};
}

test("schema: codeMode is an optional closed enum on agent tasks; omitted = default; command jobs refuse off", () => {
	assert.equal(job().task.codeMode, "default");
	assert.equal(job({ codeMode: "off" }).task.codeMode, "off");
	assert.equal(job({ codeMode: "default" }).task.codeMode, "default");
	for (const bad of ["Off", "on", true, ""]) assert.throws(() => job({ codeMode: bad }), /codeMode must be 'default' or 'off'/);
	assert.throws(() => normalizeJobs([{ ...base, task: { kind: "command", argv: ["/bin/true"], codeMode: "off" } }]), /only to agent tasks/);
	assert.equal(normalizeJobs([{ ...base, task: { kind: "command", argv: ["/bin/true"] } }])[0].task.codeMode, "default");
	assert.deepEqual(buildJobSpec({ name: "n", task: { kind: "agent", prompt: "p", codeMode: "off" } }).task, { kind: "agent", prompt: "p", codeMode: "off" });
});

test("tool schema exposes the same two-value enum (no free text)", () => {
	let create;
	registerCronTools({}, { tools: { register(def) { if (def.name === "cron_create") create = def; } } }, {}, () => null);
	assert.deepEqual(create.parameters.task.properties.codeMode.enum, ["default", "off"]);
});

test("digest/migration: an unchanged old manual record keeps its authorization; adding off changes the digest and needs re-approval", async () => {
	const tables = Object.fromEntries(["jobs", "runs", "manual", "plugin"].map((name) => { const m = new Map(); return [name, { get: (k) => m.get(k), put: async (k, v) => (m.set(k, v), v), delete: async (k) => m.delete(k), entries: () => m.entries(), keys: () => m.keys() }]; }));
	const old = { spec: structuredClone(base), authorization: { version: 1, source: "operator", digest: specDigest(base) } };
	tables.manual.put("nightly", old);
	const s = new CronService({ logger: { info() {}, warn() {}, error() {} }, storage: { domain: { open: async () => ({ table: (n) => tables[n], close: async () => {} }) } } }, { historyLimit: 5 }, [], { enabled: false });
	await s.start();
	const loaded = s.jobs.find((j) => j.name === "nightly");
	assert.equal(loaded.task.codeMode, "default");
	assert.equal(s.jobAuthorized(loaded), true, "normalization adds codeMode but the digest covers the raw spec, so old approvals stay valid");
	const tampered = { ...old, spec: { ...base, task: { ...base.task, codeMode: "off" } } };
	assert.equal(isManualJobApproved(tampered), false, "editing the stored spec to off without re-approval is not authorized");
	assert.notEqual(specDigest(tampered.spec), specDigest(base));
	await s.dispose?.();
});

test("Off: binds the exact created Session inside setup before presets, then admits the first prompt; run ok", async () => {
	const order = [], policy = policyService();
	const presets = { mount: async () => { order.push("presets"); } };
	const { ctx, made } = host({ policy, order, presets });
	const policyOrder = policy.bindCreatedSession.bind(policy);
	policy.bindCreatedSession = (agent, p) => { order.push("bind"); return policyOrder(agent, p); };
	const out = await runAgentTask(ctx, job({ codeMode: "off" }), new Date().toISOString(), undefined, "cron-nightly-1", 1);
	assert.equal(out.status, "ok");
	assert.deepEqual(order, ["create", "bind", "presets", "published", "followup", "dispose"]);
	assert.equal(policy.calls[0][1], made[0].session, "bound the exact object");
	assert.deepEqual(policy.calls[0][2], { kind: "cron", sourceId: "nightly", runId: "cron-nightly-1", initialOff: true });
	assert.equal(policy.calls[1][0], "admit");
	assert.match(made[0].sent.content[0].text, /report$/);
});

test("Off fails closed with NO prompt: service missing, incomplete, saved On conflict, or admission refusal", async () => {
	for (const policy of [undefined, {}, { bindCreatedSession() { return true; } }]) {
		const { ctx, order } = host({ policy });
		await assert.rejects(runAgentTask(ctx, job({ codeMode: "off" }), new Date().toISOString(), undefined, "cron-x"), /run policy service is unavailable/);
		assert.deepEqual(order, [], "refused before creation: no agent, no prompt");
	}
	const saved = policyService({ saved: true }), a = host({ policy: saved });
	await assert.rejects(runAgentTask(a.ctx, job({ codeMode: "off" }), new Date().toISOString(), undefined, "cron-y"), /saved On/);
	assert.equal(a.order.includes("followup"), false); assert.equal(a.order.at(-1), "dispose");
	const throwing = policyService(); throwing.bindCreatedSession = () => { throw Error("disposed"); };
	const b = host({ policy: throwing });
	await assert.rejects(runAgentTask(b.ctx, job({ codeMode: "off" }), new Date().toISOString(), undefined, "cron-z"), /disposed/);
	assert.equal(b.order.includes("followup"), false);
});

test("Default (and old jobs): never consults, binds or waits for the Code Mode service; prompt submitted directly", async () => {
	let touched = 0;
	const trap = new Proxy({}, { get() { touched++; throw Error("must not touch"); } });
	for (const policy of [undefined, trap]) {
		const { ctx, order, made } = host({ policy });
		const getter = ctx.get; ctx.get = (n) => { if (n === "codemodeRunPolicy") touched++; return getter(n); };
		const out = await runAgentTask(ctx, job(), new Date().toISOString(), undefined, "cron-d", 1);
		assert.equal(out.status, "ok"); assert.deepEqual(order, ["create", "published", "followup", "dispose"]); assert.match(made[0].sent.content[0].text, /report$/);
	}
	assert.equal(touched, 0);
});

test("Off run failure through the service is a visible failed run with no summary", async () => {
	const tables = Object.fromEntries(["jobs", "runs", "manual", "plugin"].map((name) => { const m = new Map(); return [name, { get: (k) => m.get(k), put: async (k, v) => (m.set(k, v), v), update: async (k, f) => { const v = f(m.get(k)); m.set(k, v); return v; }, delete: async (k) => m.delete(k), entries: () => m.entries(), keys: () => m.keys() }]; }));
	const { ctx } = host({ policy: undefined });
	const s = new CronService(ctx, { historyLimit: 5 }, [], { enabled: false });
	s.domain = { table: (n) => tables[n] };
	await s.addJob({ ...base, task: { ...base.task, codeMode: "off" } });
	await s.launch(s.jobs[0], Date.now(), 1);
	await s.running.get("nightly")?.promise;
	const [run] = s.runsView("nightly", 1);
	assert.equal(run.status, "failed"); assert.match(run.error, /Code Mode Off requested/); assert.equal(run.summary, "");
});
