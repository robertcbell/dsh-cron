import assert from "node:assert/strict";
import { test } from "node:test";
import { deliver, renderCronFraming, renderCronPrompt, runCallbackTask, runCommandTask, runSessionMeta, summarize } from "../lib/executor.js";

const job = (name, prompt = "do the thing") => ({ name, task: { prompt } });
const ISO = "2026-08-26T12:07:19.272Z";

test("runCommandTask: synchronous spawn failure settles as failed", async () => {
	const result = await runCommandTask({ task: { argv: [process.execPath], cwd: 42, timeoutSeconds: 1 } });
	assert.equal(result.status, "failed");
	assert.equal(result.summary, "");
	assert.match(result.error, /cwd.*must be/i);
	assert.deepEqual(Object.keys(result).sort(), ["error", "status", "summary"]);
});

test("deliver: synchronous spawn failure settles as unsuccessful", async () => {
	const result = await deliver({ delivery: { argv: [] } }, {});
	assert.equal(result.ok, false);
	assert.match(result.error, /file.*must be/i);
	assert.deepEqual(Object.keys(result).sort(), ["error", "ok"]);
});

test("renderCronFraming: framing only, no job prompt", () => {
	const text = renderCronFraming(job("t1"), ISO);
	assert.match(text, /^\[CRON RUN\]\n/);
	assert.match(text, /job: "t1"\n/);
	assert.match(text, new RegExp(`scheduled_for: ${ISO}`));
	assert.match(text, /unattended scheduled run/);
	assert.doesNotMatch(text, /do the thing/);
});

test("renderCronFraming: breaks {{ pairs in user-input job names", () => {
	const text = renderCronFraming(job("a{{evil}}b"), ISO);
	assert.doesNotMatch(text, /\{\{/);
	assert.match(text, /a\{ \{evil\}\}b/);
});

test("renderCronPrompt: fallback appends the job prompt after a blank line", () => {
	const text = renderCronPrompt(job("t1"), ISO);
	assert.equal(text, `${renderCronFraming(job("t1"), ISO)}\n\ndo the thing`);
});

test("runSessionMeta: the run Session stays plain, so the harness keeps it addressable", () => {
	const meta = runSessionMeta("C:\\jobs\\daily");
	assert.deepEqual(meta, { cwd: "C:\\jobs\\daily" });
	assert.equal(Object.hasOwn(meta, "origin"), false, "an origin tag would make the run unopenable");
	assert.equal(runSessionMeta("").cwd, process.cwd());
});

test("runCallbackTask: timeout settles without waiting for a handler that ignores abort", { timeout: 1_000 }, async () => {
	const result = await runCallbackTask(
		{ task: { kind: "callback", timeoutSeconds: 0.05 } },
		undefined,
		() => new Promise(() => {}),
	);
	assert.deepEqual(result, {
		status: "timeout",
		summary: "",
		error: "callback exceeded 0.05s",
	});
});

test("runCallbackTask: timeout aborts the signal passed to the handler", { timeout: 1_000 }, async () => {
	let signal;
	let initiallyAborted;
	await runCallbackTask(
		{ task: { kind: "callback", timeoutSeconds: 0.05 } },
		undefined,
		(context) => {
			signal = context.signal;
			initiallyAborted = signal.aborted;
			return new Promise(() => {});
		},
	);
	assert.ok(signal instanceof AbortSignal);
	assert.equal(initiallyAborted, false);
	assert.equal(signal.aborted, true);
});

test("runCallbackTask: ok false preserves the handler's summary and error", async () => {
	const result = await runCallbackTask(
		{ task: { kind: "callback", timeoutSeconds: 0.05 } },
		undefined,
		() => ({ ok: false, summary: "partial work", error: "provider unavailable" }),
	);
	assert.deepEqual(result, {
		status: "failed",
		summary: "partial work",
		error: "provider unavailable",
	});
});

const EVENTS = [
	{ seq: 0, type: "assistant/message", data: { message: { content: [{ type: "text", text: "stale" }] } } },
	{ seq: 1, type: "turn/start", data: {} },
	{ seq: 2, type: "assistant/message", data: { message: { content: [{ type: "text", text: "first" }] } } },
	{ seq: 3, type: "assistant/message", data: { message: { content: [{ type: "text", text: "final" }, { type: "tool_use" }] } } },
	{ seq: 4, type: "turn/end", data: { reason: { kind: "completed" } } },
];

test("summarize: legacy event array — only the owned interval after turn/start counts", () => {
	const out = summarize(EVENTS, 1);
	assert.equal(out.text, "final");
	assert.deepEqual(out.reason, { kind: "completed" });
	assert.equal(summarize(EVENTS, 5).text, "");
});

test("summarize: legacy session object with an events array", () => {
	assert.equal(summarize({ events: EVENTS, seq: 5 }, 1).text, "final");
});

test("summarize: V3 session exposes events via eventAt(seq) only", () => {
	const session = { seq: EVENTS.length, eventAt: (seq) => EVENTS[seq] };
	const out = summarize(session, 1);
	assert.equal(out.text, "final");
	assert.deepEqual(out.reason, { kind: "completed" });
	assert.equal(summarize(session, 4).text, "");
	assert.throws(() => summarize({ seq: 3, eventAt: () => undefined }, 1), /cannot read seq 1/);
});

test("deliver: tolerates EPIPE on stdin when the command exits without reading", async () => {
	const record = { blob: "x".repeat(4 * 1024 * 1024) };
	const j = { delivery: { argv: [process.execPath, "-e", "process.exit(0)"] } };
	const result = await deliver(j, record, process.env);
	assert.equal(result.ok, true);
});

test("deliver: reports a nonzero exit with stderr once", async () => {
	const j = { delivery: { argv: [process.execPath, "-e", "console.error('boom');process.exit(3)"] } };
	const result = await deliver(j, {}, process.env);
	assert.equal(result.ok, false);
	assert.match(result.error, /exit 3: boom/);
});
