---
name: verify-cron-single-flight
description: Re-check the dsh-cron rule "one job has at most one run executing at a time" after any change to lib/service.js runNow/dispatch/launch/settle, the overlap policy, or the storage await points. Runs an exhaustive interleaving explorer over the real code, a mutation check, and TLC when Java is available.
---

# Verify: cron single-flight

**Rule.** For one cron job, at most one run's task is executing at any time,
however `cron_run_now` calls (tool, web "Run now", double click) and scheduled
dispatches interleave with run settlement. (README "Policies"; AGENTS.md
"Preserve at-most-once dispatch, overlap/misfire policies".) A second
concurrent run of an agent job is a second paid model session.

## Rerun (one command, from the repo root)

```bash
bash verify/single-flight/run.sh
```

Exit 0 = explorer GREEN with all witnesses, every non-equivalent mutant
KILLED (M3 labelled "SURVIVED as expected"), baseline GREEN, and, when
`tla2tools.jar` is present, every TLC config meets its declared expectation
(correct models pass; `Mutant-*` must report `Invariant SingleFlight is
violated`; `Witness-*` must report their own invariant violated). Any other
java exit is a failure. Without the jar the last line says `tlc=SKIPPED`,
never PASS; `REQUIRE_TLC=1` turns SKIPPED into a failure. `--quick` skips
mutations (about 0.3 s instead of about 30 s).

## What is checked, by which tool

| Check | Tool | Status at last check |
|---|---|---|
| `verify/single-flight/explore.mjs` | Node re-execution DFS over **real** `lib/service.js`: every storage write is a deferred step, every task finish is explorer-chosen; all orders enumerated | GREEN, exhaustive in all 3 default scenarios |
| `verify/single-flight/mutate.sh` | Removes real guards in a temp copy of `lib/` | M1, M2 KILLED; M3 equivalent (survives by design) |
| `verify/single-flight/CronSingleFlight.tla` + `*.cfg` | TLA+ model, TLC | **NOT RUN**: no Java runtime on this host (`/usr/bin/java` stub only). Spec is unchecked by TLC until someone runs it. |
| `test/service.test.js` "two concurrent calls launch exactly one run" | `npm test` regression | passes with fix, fails without |

The explorer is **stateless model checking by re-execution, not TLC**.
"No violation within the bounds" does not mean impossible outside them.

## Model actions mapped to real atomic steps (`lib/service.js`)

Node runs one step at a time between `await`s; each row is one such step.

| Model action | Real code |
|---|---|
| `RunNowCheck` | `runNow()`: `authorizeCronActor`, `jobAuthorized`, first `if (this.running.has(jobName))`, up to `await jobs.update(runSeq+1)` |
| `RunNowLaunch` | `runNow()` after that await: post-await `running.has` re-check (the fix), then `launch()` which synchronously does `this.running.set` |
| `DispatchClaim` | `loop()` → `dispatch()`: `jobAuthorized`, up to `await jobs.update(lastFiredMs, runSeq+1)` |
| `DispatchRoute` | `dispatch()` after the await: `current = this.running.get`; skip → `recordSkipped`; queue → `pending.set`; none → `launch()` |
| `Settle` | `launch()` promise `.finally`: delete own running entry, relaunch parked `pending` occurrence |
| task executing | `runCallbackTask` handler body (between `gate.acquire` and settlement) |

## Bounds and assumptions

- One job; scenarios `runNow-x2` (skip), `runNow+tick-skip`, `runNow+tick-queue` (one runNow + two serialized ticks). `runNow-x3` is opt-in (`--scenario runNow-x3`) and exceeds the 200 000-schedule bound (reported TRUNCATED).
- TLC bounds (cfg): `NRunNow = 2`, `NDispatch = 2`, overlap skip or queue.
- Scheduled ticks are serialized because `loop()` awaits `dispatch()`; a second CronService instance on the same domain (two hosts) is **not** modeled.
- Only `callback` tasks are driven; `agent`/`command` share `launch()` and differ only inside the task body.
- `maxConcurrentRuns = 0` (Gate pass-through); overlap `replace` is not modeled (it intentionally cancels the old run; the old run still settles asynchronously, so "executing" may briefly overlap by design).
- Storage writes may commit in any order (each `put`/`update` is independently deferred).

## Tool versions

Node v26.13.1 (explorer). TLA+ tools: not available here; intended `tla2tools.jar` 1.8.0 (`run.sh` uses `$TLA2TOOLS` or `verify/single-flight/.tools/tla2tools.jar` when Java exists).

## Last checked

Branch `fv-pilot`, base `8ef9a5f`; last-checked commit = the lane commit that last changed this file (`git log -1 --format=%h -- .agents/skills/verify-cron-single-flight/SKILL.md`). Covered-file hashes (run.sh reports drift):

- sha256 a4e6b19e7719a640345e821fa85a8f02e1eb3feeaa5bff5a75023bea0aef59e7 `lib/service.js`
- sha256 063f1f6668dae794a54a29de26f6315296d26cee4a3412bbdc32c13475c67d98 `lib/executor.js`

Entry points into `runNow` also exist in `lib/tools.js` (`cron_run_now`) and `lib/web.js` (`RUN_NOW_PATH`); they add no locking.

## When covered code changes

Remap the table above (look for new writers of `this.running`/`this.pending`
and new `await`s inside runNow/dispatch/launch), rerun `run.sh` including
mutations, then update the hashes. Never widen the rule, shrink bounds or
mark a mutant "equivalent" to get a pass; a red result is a finding for the
Lead, and product fixes go in their own reviewed change.
