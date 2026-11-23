#!/usr/bin/env node
/**
 * Cross-package archive check (offline, no install, no host server, no model).
 * Extracted dsh-cron archive lib/agent-task.js + extracted Code Mode 0.12.0
 * archive plugin mounted in a REAL Cordis Context with REAL installed
 * DomainFacility/JSON storage, commands and Typert. Resolves @deepseek-ai/*
 * from DSH_INSTALL_DIR via Code Mode's test resolver (run with
 * --import <codemode>/test/register-dependencies.mjs). Only ctx.agents.create
 * is a seam: it runs setup(agentCtx, agent) on a fresh Session object.
 * Usage: node --import <cm>/test/register-dependencies.mjs cross-archive.mjs <cron-pkg-dir> <codemode-pkg-dir> <codemode-src-dir>
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [cronPkg, cmPkg, cmSrc] = process.argv.slice(2);
const imp = (p) => import(pathToFileURL(p).href);
const { runAgentTask } = await imp(join(cronPkg, "lib/agent-task.js"));
const { normalizeJobs } = await imp(join(cronPkg, "lib/service.js"));
const plugin = await imp(join(cmPkg, "plugin.mjs"));
const { context } = await imp(join(cmSrc, "test/support.mjs"));
const { installSelectionServices } = await imp(join(cmSrc, "test/selection-support.mjs"));
const root = mkdtempSync(join(tmpdir(), "cron-cm-cross-"));
const ctx = await context(); await installSelectionServices(ctx, root);
const out = {};
const job = (codeMode) => normalizeJobs([{ name: "nightly", schedule: { everySeconds: 3600 }, task: { kind: "agent", prompt: "go", timeoutSeconds: 5, ...(codeMode ? { codeMode } : {}) } }])[0];
const made = [];
function cronCtx() {
	return {
		logger: { info() {}, warn() {}, error() {} },
		get: (n) => ctx.get(n),
		agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) },
		sessions: { flush: async () => {} },
		agents: { create: async (o) => {
			const session = { id: o.sessionId, seq: 0, events: [], header: { id: o.sessionId }, append(type, data) { this.events.push({ type, data, seq: this.seq++ }); return this.seq; } };
			const agent = { id: o.sessionId, session, sent: [], whenIdle: async () => {}, followup(m) { this.sent.push(m); } };
			made.push(agent);
			await o.setup({ get: () => undefined, on: () => () => {}, effect: () => () => {} }, agent);
			return { agent, dispose: async () => {} };
		} },
	};
}
const signal = new AbortController().signal;
let fiber = ctx.plugin(plugin, { defaultOn: true }); await fiber.await();
try {
	await runAgentTask(cronCtx(), job("off"), new Date().toISOString(), undefined, "cron-nightly-a", 1);
	const a = made.at(-1);
	assert.equal(a.sent.length, 1); assert.equal((await ctx.codemodeSelection.status(a, signal)).enabled, false);
	const claimant = { id: a.id, session: { id: a.id, header: { id: a.id }, append() { return 1; } } };
	assert.equal((await ctx.codemodeSelection.status(claimant, signal)).enabled, true);
	out.offRunBoundAndAdmitted = true; out.sameIdClaimantUnaffected = true;
	await runAgentTask(cronCtx(), job(), new Date().toISOString(), undefined, "cron-nightly-b", 2);
	assert.equal(made.at(-1).sent.length, 1); assert.equal((await ctx.codemodeSelection.status(made.at(-1), signal)).enabled, true);
	out.defaultRunUnchanged = true;
	const pre = { id: "cron-nightly-c", session: { id: "cron-nightly-c", header: { id: "cron-nightly-c" }, events: [], append(type, data) { this.events.push({ type, data }); return this.events.length; } } };
	assert.equal((await ctx.commands.execute(pre, "/codemode-files on", [], signal)).result.kind, "success");
	await assert.rejects(runAgentTask(cronCtx(), job("off"), new Date().toISOString(), undefined, "cron-nightly-c", 3), /saved On/);
	assert.equal(made.at(-1).sent.length, 0); out.savedOnRefusedNoPrompt = true;
} finally { await fiber.dispose(); }
const before = made.length;
await assert.rejects(runAgentTask(cronCtx(), job("off"), new Date().toISOString(), undefined, "cron-nightly-d", 4), /run policy service is unavailable/);
assert.equal(made.length, before); out.missingServiceFailsClosedNoAgent = true;
await runAgentTask(cronCtx(), job(), new Date().toISOString(), undefined, "cron-nightly-e", 5);
assert.equal(made.at(-1).sent.length, 1); out.defaultRunWithoutCodeMode = true;
await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true });
out.outcome = "PASS";
console.log(JSON.stringify(out));
