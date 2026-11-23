#!/usr/bin/env bash
# One-command rerun of the cron single-flight verification.
#   bash verify/single-flight/run.sh          # explorer + mutation check
#   bash verify/single-flight/run.sh --quick  # explorer only
# Exit 0 only when: the explorer is GREEN with all witnesses, (unless
# --quick) every non-equivalent mutant is KILLED, and, if tla2tools.jar
# ($TLA2TOOLS or verify/single-flight/.tools/tla2tools.jar) exists, every TLC
# config meets its declared expectation. Without the jar TLC is reported
# SKIPPED (never PASS); set REQUIRE_TLC=1 to make that a failure.
# Every subprocess exit status is checked; no output goes through a pipe.
set -u -o pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
cd "$root" || exit 2
echo "node $(node -v); HEAD $(git rev-parse --short HEAD 2>/dev/null || echo '?')"

echo "== covered-file drift (vs SKILL.md last-checked hashes)"
skill="$root/.agents/skills/verify-cron-single-flight/SKILL.md"
drift=0
while read -r want file; do
	have="$(shasum -a 256 "$file" | cut -d' ' -f1)"
	if [ "$have" = "$want" ]; then echo "  same   $file"; else echo "  DRIFT  $file (remap actions + rerun mutations before trusting a pass)"; drift=1; fi
done < <(sed -n 's/^- sha256 \([0-9a-f]\{64\}\) `\(.*\)`$/\1 \2/p' "$skill")

echo "== real-code interleaving explorer (NOT a TLC model check)"
node "$here/explore.mjs"; rc=$?
[ $rc -eq 0 ] || { echo "explorer FAILED (rc=$rc)"; exit 1; }

if [ "${1:-}" != "--quick" ]; then
	echo "== mutation check"
	bash "$here/mutate.sh" || { echo "mutation check FAILED"; exit 1; }
fi

# ---- TLC: every configuration has an explicit expected outcome ----------
#   CronSingleFlight*.cfg  correct model        -> must PASS (no error found)
#   Witness-*.cfg          non-vacuity witness  -> its INVARIANT must be VIOLATED
#   Mutant-NoRecheck.cfg   M1 (main before fix) -> SingleFlight must be VIOLATED
#   Mutant-NoDispatchGuard M2                   -> SingleFlight must be VIOLATED
#   M3 (pre-check removed) is an equivalent mutant: no TLC config; the
#   explorer's mutate.sh expects it to SURVIVE and labels it so.
# A config "fails as expected" only if TLC names the expected invariant; an
# unrelated crash (e.g. java exiting 42) is an ERROR, never a pass.
tlc_status=SKIPPED
jar="${TLA2TOOLS:-$here/.tools/tla2tools.jar}"
if [ ! -f "$jar" ]; then
	echo "== TLC SKIPPED: tla2tools.jar not found ($jar); CronSingleFlight.tla is UNCHECKED by TLC"
elif ! java -version >/dev/null 2>&1; then
	echo "== TLC ERROR: tla2tools.jar present but no working Java runtime"
	exit 1
else
	echo "== TLC ($jar)"
	tlc_fail=0
	tlc_out="$(mktemp "${TMPDIR:-/tmp}/cron-sf-tlc.XXXXXX")"
	for cfg in "$here"/*.cfg; do
		name="$(basename "$cfg" .cfg)"
		case "$name" in
			CronSingleFlight*) expect=pass; inv="" ;;
			Mutant-*) expect=violate; inv=SingleFlight ;;
			Witness-*) expect=violate; inv="$(sed -n 's/^INVARIANTS TypeOK \([A-Za-z]*\)$/\1/p' "$cfg")" ;;
			*) echo "-- $name: no expectation declared -> ERROR"; tlc_fail=1; continue ;;
		esac
		(cd "$here" && java -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers auto -config "$name.cfg" CronSingleFlight.tla) >"$tlc_out" 2>&1
		rc=$?
		grep -E "states generated|distinct states|[Ww]arning" "$tlc_out" | sed 's/^/     /'
		if [ "$expect" = pass ]; then
			if [ $rc -eq 0 ] && grep -q "No error has been found" "$tlc_out"; then verdict="ok (passed, as expected)"
			else verdict="FAIL (expected pass; java rc=$rc)"; tlc_fail=1; tail -20 "$tlc_out"; fi
		else
			if [ $rc -ne 0 ] && [ -n "$inv" ] && grep -q "Invariant $inv is violated" "$tlc_out"; then verdict="ok ($inv violated, as expected)"
			else verdict="FAIL (expected 'Invariant $inv is violated'; java rc=$rc)"; tlc_fail=1; tail -20 "$tlc_out"; fi
		fi
		echo "-- $name [expect $expect${inv:+ $inv}]: $verdict"
	done
	rm -f "$tlc_out"
	[ $tlc_fail -eq 0 ] || { echo "TLC check FAILED"; exit 1; }
	tlc_status=PASS
fi
[ $drift -eq 0 ] || echo "NOTE: covered files drifted since last check; update SKILL.md after remapping."
mut_status=PASS; [ "${1:-}" = "--quick" ] && mut_status=SKIPPED
echo "verify single-flight: explorer=PASS mutations=$mut_status tlc=$tlc_status"
if [ "${REQUIRE_TLC:-0}" = 1 ] && [ "$tlc_status" != PASS ]; then echo "REQUIRE_TLC=1 but TLC was $tlc_status"; exit 1; fi
exit 0
