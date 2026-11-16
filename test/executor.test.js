import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChildProcess } from "node:child_process";
import { setTimeout as realSleep } from "node:timers/promises";
import { mock, test } from "node:test";
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

// Real (unmocked) timers captured at import time; mock.timers only patches what a test enables.
const tick = () => realSleep(1);
async function until(pred, what, deadlineMs = 10_000) {
	const end = Date.now() + deadlineMs;
	while (Date.now() < end) {
		if (pred()) return;
		await realSleep(10);
	}
	throw new Error(`timed out waiting for ${what}`);
}
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** Spy on timers: records handles created for 60s and which handles were cleared. */
function spyTimers() {
	mock.timers.enable({ apis: ["setTimeout"] });
	const created = [];
	const cleared = [];
	const realSet = globalThis.setTimeout;
	const realClear = globalThis.clearTimeout;
	mock.method(globalThis, "setTimeout", (fn, ms, ...a) => {
		const h = realSet(fn, ms, ...a);
		created.push({ h, ms });
		return h;
	});
	mock.method(globalThis, "clearTimeout", (h) => {
		cleared.push(h);
		return realClear(h);
	});
	return { created, cleared };
}
const resetTimers = () => {
	mock.restoreAll();
	mock.timers.reset();
};

test("deliver: 60s timeout kills the child and settles once with the timeout error", async () => {
	const dir = mkdtempSync(join(tmpdir(), "deliver-to-"));
	const pidFile = join(dir, "pid");
	let pid;
	let spy;
	let child;
	const realSpawn = ChildProcess.prototype.spawn;
	try {
		// Capture the child synchronously so teardown never depends on the pid-file handshake.
		ChildProcess.prototype.spawn = function (...a) {
			child = this;
			return realSpawn.apply(this, a);
		};
		spy = spyTimers();
		const script = `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1e3)`;
		const p = deliver({ delivery: { argv: [process.execPath, "-e", script] } }, { id: 1 });
		ChildProcess.prototype.spawn = realSpawn;
		assert.ok(child?.pid, "child captured at spawn");
		assert.deepEqual(spy.created.map((c) => c.ms), [60_000]);
		await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8"), "child pid");
		pid = Number(readFileSync(pidFile, "utf8"));
		assert.ok(alive(pid));
		let settledEarly = false;
		p.then(() => { settledEarly = true; });
		mock.timers.tick(59_999);
		await tick();
		assert.equal(settledEarly, false, "must not settle before 60s");
		assert.ok(alive(pid));
		mock.timers.tick(1);
		assert.deepEqual(await p, { ok: false, error: "delivery command exceeded 60s" });
		await until(() => !alive(pid), "child killed");
		// The late "close" (code null from SIGKILL) must not change anything: timer cleared, no re-fire.
		await until(() => spy.cleared.includes(spy.created[0].h), "clearTimeout on close");
		assert.equal(spy.created.length, 1);
		mock.timers.tick(120_000);
		assert.deepEqual(await p, { ok: false, error: "delivery command exceeded 60s" });
	} finally {
		ChildProcess.prototype.spawn = realSpawn;
		resetTimers();
		pid ??= child?.pid;
		if (pid && alive(pid)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
			await until(() => !alive(pid), "leaked child reaped", 5_000).catch(() => {});
		}
		rmSync(dir, { recursive: true, force: true });
	}
});

test("deliver: error event then close settles once with the error, not an exit code", async () => {
	const events = [];
	const realEmit = ChildProcess.prototype.emit;
	try {
		ChildProcess.prototype.emit = function (name, ...args) {
			if (name === "error" || name === "close") events.push(name);
			return realEmit.call(this, name, ...args);
		};
		const spy = spyTimers();
		const result = await deliver({ delivery: { argv: ["/nonexistent/dsh-cron-no-such-cmd"] } }, {});
		// Observe that BOTH events really fired (close follows error) before judging the outcome.
		await until(() => events.includes("error") && events.includes("close"), "error and close events");
		assert.ok(events.indexOf("error") < events.indexOf("close"));
		assert.equal(result.ok, false);
		assert.match(result.error, /ENOENT/);
		assert.doesNotMatch(result.error, /^exit /);
		assert.deepEqual(Object.keys(result).sort(), ["error", "ok"]);
		assert.equal(spy.created.length, 1);
		assert.ok(spy.cleared.includes(spy.created[0].h), "error path clears the 60s timer");
		mock.timers.tick(120_000);
	} finally {
		ChildProcess.prototype.emit = realEmit;
		resetTimers();
	}
});

test("deliver: normal exit clears the timer so it never fires afterwards", async () => {
	try {
		const spy = spyTimers();
		const ok = await deliver({ delivery: { argv: [process.execPath, "-e", "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"] } }, { a: 1 });
		assert.deepEqual(ok, { ok: true });
		assert.ok(spy.cleared.includes(spy.created[0].h));
		const bad = await deliver({ delivery: { argv: [process.execPath, "-e", "console.error('boom');process.exit(3)"] } }, {});
		assert.deepEqual(bad, { ok: false, error: "exit 3: boom\n" });
	} finally {
		resetTimers();
	}
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
