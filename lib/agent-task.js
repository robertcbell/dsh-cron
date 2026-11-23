/**
 * dsh-cron — the agent task executor.
 *
 * Follows the @deepseek-ai/dsh-headless one-shot recipe verbatim: create a
 * fresh persisted agent through `ctx.agents`, submit the prompt as an
 * ordinary user message, wait for quiescence, flush, summarize the owned
 * event interval, dispose the handle. Split from ./executor.js because this
 * is the one module that imports dsh host packages; the service imports it
 * lazily, only when an agent task actually launches.
 * @module dsh-cron/agent-task
 */
import { applyTaskAccess } from "./security.js";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { ReasoningEffortId, createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { renderCronFraming, renderCronPrompt, runSessionMeta, summarize, tail } from "./executor.js";

/** Host-only Code Mode service (dsh-codemode >= 0.12.0); never a Remote/tool surface. */
const CODEMODE_RUN_POLICY = "codemodeRunPolicy";

/**
 * Run one agent task to settlement.
 * @param control - cancellation seam; teardown disposes the agent handle.
 * @param sessionId - pre-minted id: the caller records it durably BEFORE the
 *   agent exists, so session-file GC can never mistake a live run's session
 *   for an orphan.
 * @param seq - the run's per-job sequence number; names the session
 *   `<job> #<seq>` so the header identifies the run, not the prompt's words.
 * @returns `{status: "ok"|"failed"|"timeout", summary, sessionId, error?}`
 */
export async function runAgentTask(ctx, job, targetIso, control, sessionId, seq) {
	const optional = (name) => (typeof ctx.get === "function" ? ctx.get(name) : undefined);
	const selection = ctx.agentDefaultModel.currentSelection();
	const provider = job.task.provider !== "" ? job.task.provider : selection.provider;
	const model = job.task.model !== "" ? job.task.model : selection.model;
	// An explicit effort wins; an explicit model with no effort clears the
	// inherited one (the default selection's effort may not exist on it).
	const effort = job.task.effort !== ""
		? ReasoningEffortId(job.task.effort)
		: job.task.model !== "" ? undefined : selection.reasoningEffort;
	const presets = optional("agentPresets");
	// codeMode "off": the host-only Code Mode run policy binds the EXACT Session object handed to
	// native creation setup (never the pre-recorded id, which an ordinary session.create can claim),
	// then admits the first prompt only under a verified effective Off. Missing/not-ready service
	// fails the run before creation: no prompt, no fallback On. "default" never touches the service.
	const codeModeOff = job.task.codeMode === "off";
	const runPolicy = codeModeOff ? optional(CODEMODE_RUN_POLICY) : undefined;
	if (codeModeOff && (typeof runPolicy?.bindCreatedSession !== "function" || typeof runPolicy?.admitInitialOff !== "function")) {
		throw new Error("cron: Code Mode Off requested but the Code Mode run policy service is unavailable; run refused before its first prompt");
	}
	let boundOff = false;
	// The unattended framing rides the system prompt, not the user message:
	// the transcript keeps only the author's prompt, and an interactive
	// resume (where dsh-cron is not in the setup path) sheds the never-ask
	// rule. Hosts without the service fall back to in-message framing.
	let framingInstalled = false;
	// The run's Session header stays plain — see runSessionMeta for why the
	// `origin: "subagent"` tag this executor used to set made every finished run
	// unopenable.
	const handle = await ctx.agents.create({
		sessionId: SessionId(sessionId),
		meta: runSessionMeta(job.task.cwd),
		agentOptions: { provider, model },
		setup: async (agentCtx, agent) => {
			// First, before presets or any other setup consumer can observe the Session.
			if (codeModeOff) {
				runPolicy.bindCreatedSession(agent, { kind: "cron", sourceId: job.name, runId: sessionId, initialOff: true });
				boundOff = true;
			}
			installModelSelection(agentCtx, {
				current: { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) },
				assembled: undefined,
			});
			// Join the same preset composition an interactive session would;
			// hosts without the presets service keep the bare-agent behavior.
			if (presets !== undefined) {
				await presets.mount(agentCtx, job.task.preset !== "" ? job.task.preset : undefined);
			}
			const systemPrompt = typeof agentCtx.get === "function" ? agentCtx.get("systemPrompt") : undefined;
			if (systemPrompt !== undefined) {
				// After every static section (persona 0, tool guidance
				// 100–199): the framing carries a per-run timestamp, and
				// prefix-based prompt caching stops sharing at the first
				// divergent token — variable text must sit last.
				systemPrompt.section({
					name: "dsh-cron:unattended",
					order: 900,
					text: renderCronFraming(job, targetIso),
				});
				framingInstalled = true;
			}
		},
	});
	const { agent } = handle;
	// Pin the deterministic run title before the prompt lands: a user-source
	// title suppresses the automatic first-prompt/LLM titling entirely.
	if (seq !== undefined) {
		const titles = optional("sessionTitle");
		if (titles !== undefined) {
			try {
				titles.rename(agent.session, `${job.name} #${seq}`);
			} catch (error) {
				ctx.logger.warn(`cron: job '${job.name}' run title not set: ${String(error)}`);
			}
		}
	}
	control?.register(() => {
		handle.dispose().catch(() => {});
	});
	try {
		applyTaskAccess(ctx, agent.session, job.task.access);
		await agent.whenIdle();
		const firstSeq = agent.session.seq;
		// Synchronous: queues exactly the first followup, no await between admission and submit.
		const submit = () => agent.followup(
			createUserMessage({
				content: [{ type: "text", text: framingInstalled ? job.task.prompt : renderCronPrompt(job, targetIso) }],
				source: { kind: "user" },
			}),
		);
		if (codeModeOff) {
			if (!boundOff) throw new Error("cron: Code Mode Off binding missing after creation; run refused before its first prompt");
			await runPolicy.admitInitialOff(agent, submit);
		} else {
			submit();
		}
		let timer;
		const timedOut = new Promise((resolve) => {
			timer = setTimeout(() => resolve("timeout"), job.task.timeoutSeconds * 1000);
		});
		const races = [agent.whenIdle().then(() => "idle"), timedOut];
		if (control !== undefined) races.push(control.whenCancelled.then(() => "cancelled"));
		const winner = await Promise.race(races);
		clearTimeout(timer);
		if (winner === "cancelled") {
			// The service overrides the status with the cancel reason.
			return { status: "failed", summary: "", sessionId, error: "cancelled" };
		}
		if (winner === "timeout") {
			return {
				status: "timeout",
				summary: "",
				sessionId,
				error: `agent run exceeded ${job.task.timeoutSeconds}s`,
			};
		}
		await ctx.sessions.flush(agent.session);
		const outcome = summarize(agent.session, firstSeq);
		const failed = outcome.reason?.kind === "error";
		return {
			status: failed ? "failed" : "ok",
			summary: tail(outcome.text),
			sessionId,
			error: failed ? `${outcome.reason.error?.code ?? "error"}: ${outcome.reason.error?.message ?? ""}` : undefined,
		};
	} finally {
		// Dispose stops the loop and unregisters the agent; the persisted
		// session file remains on disk for later inspection/resume.
		await handle.dispose().catch(() => {});
	}
}

