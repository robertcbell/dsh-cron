# verify/codemode-off — trusted per-job Code Mode Off

**Promise:** an ordinary chat (session create/claim/reclaim/adopt by id, or a
selection change) can neither gain nor lose a cron job's owner-chosen initial
Code Mode Off. Source contract: DeepSeekHarness
`specialists/research/codemode-run-provenance-20261123/DESIGN.md`
(sha256 ab4c64a5c31ab21012d5ba127bdd61bd5cd85678f6468b5b68d04aef56b7f07c).

Rules checked on every schedule: G1 a non-runner object under the run id never
reads Off because of the run; G2 only the runner's exact-bound Session passes
`admitInitialOff`; L1 an Off job submits only under live exact binding, a
committed saved choice that is not On, and no On request issued before admission;
L2 an unsaved runner Session never reads On after Agent publication; L3 no prompt
without a live service. Default jobs never touch the service (forbidden witness).

Tool: **real-code interleaving explorer, NOT a TLC model check.** Real code:
`lib/agent-task.js` (with executor/security/service normalisation) and
dsh-codemode `run-policy.mjs` + `selection.mjs`. Seams: host packages, the
native factory (prepare -> setup(agentCtx, agent) -> publish -> idle as separate
steps, as in dsh-agent-loop 0.2.2-rc.5), Code Mode storage commits, and
plugin wiring (`createSelection({boundOff: offFor})`, as plugin.mjs does;
plugin.mjs is covered by the Code Mode suite and production-archive proof).

Bounds: 10 scenarios, 2–3 actors each, DFS exhaustive (largest 924 schedules,
<=12 steps); a 3-actor concurrent+claim scenario exceeded 200k schedules and was
split into two-actor scenarios. "No violation within bounds" is not "impossible".
Backend collision behaviour is modelled both ways (reject / permit same id).

Mutations (temp copies only): M1 id-keyed binding, M2 admission without exact
binding, M3 saved-On accepted, M4 admission outside the per-session queue, M5
all liveness checks removed, M6 bind after creation instead of in setup, M7
missing service downgrades to Default, M8 cron submits without admission — each
KILLED with a numbered shortest trace. Declared equivalent (defence in depth,
expected to survive): M5b run-policy liveness only (selection close still
refuses), M9 cron's own boundOff recheck (admission requires the binding).

Not covered: real DSH host/session store, durable resume (binding is
intentionally non-durable), GUI, model requests, Task Board (deferred).

Rerun: `CODEMODE_PLUGIN_DIR=<dsh-codemode> bash verify/codemode-off/run.sh`.

Last checked: see `last-run.txt` (covered sha256, explorer and mutation output).
