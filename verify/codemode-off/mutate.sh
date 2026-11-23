#!/usr/bin/env bash
# Guard-removal check for verify/codemode-off. Each mutant removes ONE real
# guard in a temp copy (never the working tree) of dsh-cron lib/ or of
# dsh-codemode run-policy.mjs/selection.mjs, and must go RED with a numbered
# shortest counterexample; then the unmutated code must be GREEN.
# Usage (repo root): CODEMODE_PLUGIN_DIR=<dsh-codemode dir> bash verify/codemode-off/mutate.sh
set -u
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
cm="${CODEMODE_PLUGIN_DIR:?set CODEMODE_PLUGIN_DIR to the dsh-codemode plugin directory}"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/cron-cmoff-mut.XXXXXX")"
trap 'rm -rf "${tmp:?}"' EXIT
status=0

# mutant NAME TARGET(cron|codemode) FILE PYTHON-BODY SCENARIO [expect=killed|survives]
mutant() {
	local name="$1" target="$2" file="$3" body="$4" scenario="$5" expect="${6:-killed}" dir="$tmp/$1"
	mkdir -p "$dir/lib" "$dir/cm"
	cp "$root"/lib/*.js "$dir/lib/" && cp "$cm/run-policy.mjs" "$cm/selection.mjs" "$dir/cm/" || exit 2
	local f; if [ "$target" = cron ]; then f="$dir/lib/$file"; else f="$dir/cm/$file"; fi
	F="$f" python3 -c "
import os
f=os.environ['F']; s=open(f).read()
def sub(old,new):
    global s
    assert s.count(old)==1, 'anchor count %d: %r' % (s.count(old), old[:60])
    s=s.replace(old,new)
$body
open(f,'w').write(s)
" || { echo "mutation $name could not be applied"; exit 2; }
	echo "### mutant $name (scenario $scenario)"
	node "$here/explore.mjs" --cron-lib "$dir/lib" --codemode "$dir/cm" --scenario "$scenario" >"$tmp/$name.out" 2>&1
	local rc=$?
	cat "$tmp/$name.out"
	if [ "$expect" = survives ]; then
		if [ $rc -eq 0 ]; then echo "### mutant $name: SURVIVED as declared (equivalent: see comment)"; else echo "### mutant $name: unexpectedly RED (rc=$rc) -- re-examine the equivalence claim"; status=1; fi
	elif [ $rc -eq 1 ] && grep -q "VIOLATION" "$tmp/$name.out"; then
		echo "### mutant $name: KILLED (RED with counterexample, as expected)"
	else
		echo "### mutant $name: SURVIVED (rc=$rc) -- check is too weak"; status=1
	fi
}

# IDENTITY guard: provenance keyed by session id string instead of the exact Session object.
mutant M1-id-key codemode run-policy.mjs "
sub('const bindings=new WeakMap()','const bindings=new Map()')
sub('const exact=agent=>{const binding=bindings.get(sessionOf(agent));','const exact=agent=>{const binding=bindings.get(agent?.id);')
sub('bindings.set(session,snapshot);','bindings.set(agent.id,snapshot);')
sub('if(bindings.has(session))','if(false)')" pending-claim-permit
# IDENTITY guard (admission): admitInitialOff no longer requires the exact binding.
mutant M2-no-exact-admission codemode run-policy.mjs "
sub('const assertBound=agent=>{assertLive();if(!exact(agent))throw','const assertBound=agent=>{assertLive();if(false)throw')" claim-default-off
# SAVED-ON guard: admission accepts any effective value (saved On submitted while effective On).
mutant M3-saved-on codemode selection.mjs "
sub(\"if(effective!==false)throw new Error\",\"if(false)throw new Error\")" on-vs-admission
# SERIALIZATION guard: admission reads outside the per-session queue (verify-then-submit gap).
mutant M4-unserialized codemode selection.mjs "
sub(\"return serial(agent,undefined,async(table,id,a)=>{\n        const effective=await read(table,id,a);\",\"return (async(table,id,a)=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();\n        const effective=await read(table,id,a);\")
sub(\"        return submit();\n      });\",\"        return submit();\n      })(lastTable,sessionKey(agent),agent);\")
sub(\"    const id=sessionKey(agent),prior=queues.get(id)??Promise.resolve();\",\"    const id=sessionKey(agent),prior=queues.get(id)??Promise.resolve();void ready.then(d=>{lastTable=d.table('sessions');});\")
sub(\"let closed=false,closing;\",\"let closed=false,closing,lastTable;\")" on-vs-admission
# LIVENESS guards: run-policy generation/liveness AND selection closed check removed.
mutant M5-no-liveness codemode run-policy.mjs "
sub(\"const assertLive=()=>{if(!live)throw\",\"const assertLive=()=>{if(false)throw\")
sub(\"function offFor(agent){return live&&\",\"function offFor(agent){return \")
import os
p=os.path.join(os.path.dirname(f),'selection.mjs'); t=open(p).read()
old=\"        assertOpen();\n        return submit();\"
assert t.count(old)==1
t=t.replace(old,\"        return submit();\")
old2=\"const assertOpen=signal=>{signal?.throwIfAborted();if(closed)throw new Error('Code Mode selection disposed');};\"
assert t.count(old2)==1
t=t.replace(old2,\"const assertOpen=signal=>{signal?.throwIfAborted();};\")
open(p,'w').write(t)" unload-race
# Declared EQUIVALENT (defence in depth): removing only run-policy liveness leaves the selection's
# closed check, which still refuses admission after unload. Expected to survive.
mutant M5b-runpolicy-liveness-only codemode run-policy.mjs "
sub(\"const assertLive=()=>{if(!live)throw\",\"const assertLive=()=>{if(false)throw\")
sub(\"function offFor(agent){return live&&\",\"function offFor(agent){return \")" unload-race survives
# SETUP guard: cron binds after native creation (after publication and idle), not inside setup.
mutant M6-bind-after-create cron agent-task.js "
sub('''			if (codeModeOff) {
				runPolicy.bindCreatedSession(agent, { kind: \"cron\", sourceId: job.name, runId: sessionId, initialOff: true });
				boundOff = true;
			}
''','')
sub('''		const firstSeq = agent.session.seq;
''','''		if (codeModeOff) { runPolicy.bindCreatedSession(agent, { kind: \"cron\", sourceId: job.name, runId: sessionId, initialOff: true }); boundOff = true; }
		const firstSeq = agent.session.seq;
''')" blank-adopt
# FAIL-CLOSED guard: a missing service silently downgrades an Off job to Default (fallback On).
mutant M7-missing-service-fallback cron agent-task.js "
sub('const codeModeOff = job.task.codeMode === \"off\";','const codeModeOff = job.task.codeMode === \"off\" && optional(CODEMODE_RUN_POLICY) !== undefined;')" boot-not-ready
# ADMISSION guard: cron submits the first prompt directly after binding (no effective-Off admission).
mutant M8-no-admission cron agent-task.js "
sub('			await runPolicy.admitInitialOff(agent, submit);','			submit();')" on-vs-admission
# Declared EQUIVALENT: cron's own boundOff check duplicates admission's exact-binding requirement.
mutant M9-no-cron-bound-check cron agent-task.js "
sub('			if (!boundOff) throw new Error','			if (false) throw new Error')" pending-claim-permit survives

echo "### baseline (unmutated code)"
node "$here/explore.mjs" --cron-lib "$root/lib" --codemode "$cm" >"$tmp/base.out" 2>&1; rc=$?
grep -E "^== |schedules explored|result" "$tmp/base.out"
if [ $rc -eq 0 ]; then echo "### baseline: GREEN"; else cat "$tmp/base.out"; echo "### baseline: RED (rc=$rc)"; status=1; fi
exit $status
