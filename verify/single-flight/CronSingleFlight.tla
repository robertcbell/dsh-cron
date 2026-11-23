---------------------------- MODULE CronSingleFlight ----------------------------
(***************************************************************************)
(* Rule: one cron job has at most one run whose task is executing at any   *)
(* time ("single-flight"), however scheduled dispatch, run-now requests   *)
(* (tool call / web click / double click) and run settlement interleave.   *)
(*                                                                         *)
(* One job, overlap policy skip or queue.  Each action is one atomic step  *)
(* of lib/service.js between two `await`s (Node runs one step at a time):  *)
(*                                                                         *)
(*  RunNowCheck(i)   runNow(): authorize + `if (this.running.has(...))`    *)
(*                   refusal, up to `await jobs.update(runSeq+1)`          *)
(*  RunNowLaunch(i)  runNow() after the update resolves: optional          *)
(*                   re-check (RecheckAfterAwait), then launch(), which    *)
(*                   synchronously does `this.running.set(job, entry)`     *)
(*  DispatchClaim(t) loop() -> dispatch(): authorize, up to                *)
(*                   `await jobs.update(lastFiredMs, runSeq+1)`            *)
(*  DispatchRoute(t) dispatch() after the update: `current = running.get`; *)
(*                   skip -> recordSkipped; queue -> pending.set;          *)
(*                   none -> launch()                                      *)
(*  Settle(r)        launch() promise .finally(): delete the running entry *)
(*                   only if it is still this run's, then launch the       *)
(*                   parked pending occurrence, if any                     *)
(*                                                                         *)
(* Flags model the real guards so a mutation is a one-line cfg change:     *)
(*   RunNowGuard        the `running.has` refusal(s) in runNow()           *)
(*   RecheckAfterAwait  re-check after `await update` (lane fix)           *)
(*   DispatchGuard      `if (current !== undefined)` in dispatch()         *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS NRunNow, NDispatch, Overlap, RunNowGuard, RecheckAfterAwait, DispatchGuard

ASSUME NRunNow \in Nat /\ NDispatch \in Nat /\ Overlap \in {"skip", "queue"}
ASSUME RunNowGuard \in BOOLEAN /\ RecheckAfterAwait \in BOOLEAN /\ DispatchGuard \in BOOLEAN

Requests == 1..NRunNow
Ticks    == 1..NDispatch
NoRun    == 0

VARIABLES
    rn,        \* rn[i]: "idle" | "awaiting" | "launched" | "refused"
    dp,        \* dp[t]: "idle" | "awaiting" | "launched" | "skipped" | "parked"
    entry,     \* run id held in service.running for this job, or NoRun
    inflight,  \* ids of launched runs whose task has not settled
    pending,   \* TRUE iff an occurrence is parked in service.pending (queue)
    nextId,    \* next run id to mint
    finished   \* number of runs that settled (success witness)

vars == <<rn, dp, entry, inflight, pending, nextId, finished>>

TypeOK ==
    /\ rn \in [Requests -> {"idle", "awaiting", "launched", "refused"}]
    /\ dp \in [Ticks -> {"idle", "awaiting", "launched", "skipped", "parked"}]
    /\ entry \in Nat
    /\ inflight \subseteq Nat
    /\ pending \in BOOLEAN
    /\ nextId \in Nat
    /\ finished \in Nat

Init ==
    /\ rn = [i \in Requests |-> "idle"]
    /\ dp = [t \in Ticks |-> "idle"]
    /\ entry = NoRun
    /\ inflight = {}
    /\ pending = FALSE
    /\ nextId = 1
    /\ finished = 0

\* launch(): running.set(job, entry) happens synchronously with the decision.
LaunchNew ==
    /\ entry' = nextId
    /\ inflight' = inflight \cup {nextId}
    /\ nextId' = nextId + 1

RunNowCheck(i) ==
    /\ rn[i] = "idle"
    /\ rn' = [rn EXCEPT ![i] = IF RunNowGuard /\ entry # NoRun THEN "refused" ELSE "awaiting"]
    /\ UNCHANGED <<dp, entry, inflight, pending, nextId, finished>>

RunNowLaunch(i) ==
    /\ rn[i] = "awaiting"
    /\ IF RunNowGuard /\ RecheckAfterAwait /\ entry # NoRun
          THEN /\ rn' = [rn EXCEPT ![i] = "refused"]
               /\ UNCHANGED <<entry, inflight, nextId>>
          ELSE /\ rn' = [rn EXCEPT ![i] = "launched"]
               /\ LaunchNew
    /\ UNCHANGED <<dp, pending, finished>>

DispatchClaim(t) ==
    /\ dp[t] = "idle"
    /\ dp' = [dp EXCEPT ![t] = "awaiting"]
    /\ UNCHANGED <<rn, entry, inflight, pending, nextId, finished>>

DispatchRoute(t) ==
    /\ dp[t] = "awaiting"
    /\ IF DispatchGuard /\ entry # NoRun
          THEN IF Overlap = "skip"
                  THEN /\ dp' = [dp EXCEPT ![t] = "skipped"]
                       /\ UNCHANGED <<entry, inflight, pending, nextId>>
                  ELSE /\ dp' = [dp EXCEPT ![t] = "parked"]
                       /\ pending' = TRUE   \* only the latest parked target survives
                       /\ UNCHANGED <<entry, inflight, nextId>>
          ELSE /\ dp' = [dp EXCEPT ![t] = "launched"]
               /\ LaunchNew
               /\ UNCHANGED pending
    /\ UNCHANGED <<rn, finished>>

Settle(r) ==
    /\ r \in inflight
    /\ finished' = finished + 1
    /\ IF pending
          THEN /\ pending' = FALSE
               /\ entry' = nextId
               /\ inflight' = (inflight \ {r}) \cup {nextId}
               /\ nextId' = nextId + 1
          ELSE /\ entry' = IF entry = r THEN NoRun ELSE entry
               /\ inflight' = inflight \ {r}
               /\ UNCHANGED <<pending, nextId>>
    /\ UNCHANGED <<rn, dp>>

Done ==
    /\ \A i \in Requests : rn[i] \in {"launched", "refused"}
    /\ \A t \in Ticks : dp[t] \in {"launched", "skipped", "parked"}
    /\ inflight = {}
    /\ UNCHANGED vars

Next ==
    \/ \E i \in Requests : RunNowCheck(i) \/ RunNowLaunch(i)
    \/ \E t \in Ticks : DispatchClaim(t) \/ DispatchRoute(t)
    \/ \E r \in inflight : Settle(r)
    \/ Done

Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

(* Safety: the rule. *)
SingleFlight == Cardinality(inflight) <= 1

(* Liveness / non-vacuity: some run actually completes in every behavior. *)
SomeRunFinishes == <>(finished >= 1)

(* Non-vacuity witnesses: check each as an INVARIANT and expect a violation; *)
(* the counterexample shows the good path is reachable.                    *)
NeverFinishes      == finished = 0
NeverRefused       == \A i \in Requests : rn[i] # "refused"
NeverSkippedOrParked == \A t \in Ticks : dp[t] \notin {"skipped", "parked"}
=============================================================================
