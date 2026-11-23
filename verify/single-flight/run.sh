#!/usr/bin/env bash
# One-command rerun of the cron single-flight verification.
#   bash verify/single-flight/run.sh          # explorer + mutation check
#   bash verify/single-flight/run.sh --quick  # explorer only
# Exit 0 only when: covered-file drift is reported, the explorer is GREEN
# with all witnesses, and (unless --quick) every non-equivalent mutant is
# KILLED. TLC is run additionally if a working Java runtime and
# tla2tools.jar ($TLA2TOOLS or verify/single-flight/.tools/tla2tools.jar) exist.
set -u
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

jar="${TLA2TOOLS:-$here/.tools/tla2tools.jar}"
if java -version >/dev/null 2>&1 && [ -f "$jar" ]; then
	echo "== TLC"
	for cfg in "$here"/*.cfg; do
		echo "-- $(basename "$cfg"): $(head -1 "$cfg")"
		(cd "$here" && java -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers auto -config "$(basename "$cfg")" CronSingleFlight.tla) | tail -8
	done
else
	echo "== TLC skipped: no working Java runtime and/or tla2tools.jar (spec CronSingleFlight.tla is UNCHECKED by TLC)"
fi
[ $drift -eq 0 ] || echo "NOTE: covered files drifted since last check; update SKILL.md after remapping."
echo "verify single-flight: PASS"
