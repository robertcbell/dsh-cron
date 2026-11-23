#!/usr/bin/env bash
# One-command rerun of the trusted per-job Code Mode Off check.
#   CODEMODE_PLUGIN_DIR=<dsh-codemode dir> bash verify/codemode-off/run.sh [--quick]
# Exit 0 only when the real-code explorer is GREEN with all witnesses and (unless
# --quick) every non-equivalent guard mutant is KILLED. No TLA+ model for this
# rule: this is a real-code interleaving explorer, NOT a TLC model check.
set -u -o pipefail
here="$(cd "$(dirname "$0")" && pwd)"; root="$(cd "$here/../.." && pwd)"
cd "$root" || exit 2
cm="${CODEMODE_PLUGIN_DIR:?set CODEMODE_PLUGIN_DIR to the dsh-codemode plugin directory (0.12.0+)}"
echo "node $(node -v); cron HEAD $(git rev-parse --short HEAD 2>/dev/null || echo '?'); codemode $(git -C "$cm" rev-parse --short HEAD 2>/dev/null || echo '?')"
echo "== covered-file hashes"
for f in lib/agent-task.js lib/service.js lib/executor.js lib/security.js; do shasum -a 256 "$f"; done
for f in run-policy.mjs selection.mjs; do shasum -a 256 "$cm/$f"; done
echo "== real-code interleaving explorer (NOT a TLC model check)"
node "$here/explore.mjs" --cron-lib "$root/lib" --codemode "$cm"; rc=$?
[ $rc -eq 0 ] || { echo "explorer FAILED (rc=$rc)"; exit 1; }
if [ "${1:-}" != "--quick" ]; then
	echo "== guard-removal mutations"
	CODEMODE_PLUGIN_DIR="$cm" bash "$here/mutate.sh" || { echo "mutation check FAILED"; exit 1; }
fi
echo "verify codemode-off: explorer=PASS mutations=$([ "${1:-}" = --quick ] && echo SKIPPED || echo PASS) tlc=NOT-APPLICABLE"
