#!/usr/bin/env bash
# Mutation check: break each real guard of lib/service.js in a temp copy of
# lib/, expect the explorer to go RED with a counterexample; then confirm the
# unmutated lib is GREEN. Never edits lib/ itself.
# Usage (repo root): bash verify/single-flight/mutate.sh
set -u
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/cron-sf-mut.XXXXXX")"
trap 'rm -rf "${tmp:?}"' EXIT
status=0

# The two runNow guards share this exact text; index 0 = pre-await check,
# index 1 = post-await re-check (the lane fix).
GUARD='if (this.running.has(jobName)) {
			return {
				code: "already_running",
				message: `job '"'"'${jobName}'"'"' has a run in flight; wait for it to settle (see cron_runs)`,
			};
		}'

mutant() { # name, python body operating on s / G, [expect=killed|survives]
	local name="$1" body="$2" expect="${3:-killed}" dir="$tmp/$1"
	mkdir -p "$dir" && cp "$root"/lib/*.js "$dir"/
	G="$GUARD" F="$dir/service.js" python3 -c "
import os
f=os.environ['F']; s=open(f).read(); G=os.environ['G']
assert s.count(G)==2, 'runNow guard anchors changed: %d' % s.count(G)
def drop(s, k):
    i=-1
    for _ in range(k+1): i=s.index(G, i+1)
    return s[:i]+'/* MUTATED: guard removed */'+s[i+len(G):]
$body
open(f,'w').write(s)
" || { echo "mutation $name could not be applied"; exit 2; }
	echo "### mutant $name"
	node "$here/explore.mjs" --lib "$dir" >"$tmp/$name.out" 2>&1
	local rc=$?
	cat "$tmp/$name.out"
	if [ "$expect" = survives ]; then
		if [ $rc -eq 0 ]; then echo "### mutant $name: SURVIVED as expected (equivalent mutant for this rule)"
		else echo "### mutant $name: unexpectedly RED (rc=$rc) -- re-examine the equivalence claim"; status=1; fi
	elif [ $rc -eq 1 ] && grep -q "VIOLATION" "$tmp/$name.out"; then
		echo "### mutant $name: KILLED (explorer RED as expected)"
	else
		echo "### mutant $name: SURVIVED (rc=$rc) -- check is too weak"; status=1
	fi
}

# M1: drop the post-await re-check in runNow (= the code before the lane fix).
mutant M1-no-recheck 's=drop(s,1)'
# M2: dispatch() ignores the run in flight (overlap guard removed).
mutant M2-no-dispatch-guard "assert s.count('if (current !== undefined) {')==1; s=s.replace('if (current !== undefined) {','if (false) {')"
# M3: drop the pre-await runNow check only (re-check kept). EQUIVALENT for
# single-flight: the post-await re-check alone refuses; the pre-check only
# saves a wasted runSeq increment. Expected to survive; if it ever goes RED,
# the re-check is no longer sufficient on its own.
mutant M3-no-precheck 's=drop(s,0)' survives

echo "### baseline (unmutated lib)"
node "$here/explore.mjs" --lib "$root/lib"; rc=$?
if [ $rc -eq 0 ]; then echo "### baseline: GREEN"; else echo "### baseline: RED (rc=$rc)"; status=1; fi
exit $status
