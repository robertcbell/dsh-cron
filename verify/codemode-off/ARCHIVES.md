# Archives (offline evidence, 2026-11-23; nothing installed)

| Package | Archive | sha256 | Built from |
|---|---|---|---|
| @local/dsh-codemode 0.12.0 | `~/.dsh/profiles/web/vendor/local-dsh-codemode-0.12.0.tgz` | `a48c935a4c93d0075b18f242e073715af9e2850117945904ccf8020e573075c6` | Repos `task/codemode-cron-off-v1` 71a8446 (rebased on main aebc48a, includes 0.9.0–0.11.0) |
| dsh-cron 0.14.6-codemode-off.1 | `~/.dsh/profiles/web/vendor/dsh-cron-0.14.6-codemode-off.1.tgz` | `c9c332b321529df98f0e52274648fff9a6bee90f18eb8fe40811b9544d041743` | dsh-cron `task/cron-codemode-off-v1` 1d07680 (baseline d1b1bcf = installed 0.14.5 bytes) |

Checks:
- Code Mode, fresh `git archive` copy per its VERIFY.md (non-temp folder): 72/72 tests, build OK, generated unchanged, package-check PASS, production archive PASS including `exactSessionRunPolicyFromArchive`; 29 archive members byte-identical to source.
- dsh-cron: 18 archive members byte-identical to the lane; 119/119 tests run against the extracted archive lib; explorer PASS against the extracted lib.
- `cross-archive.mjs` (both extracted archives, real Cordis/storage/commands): Off run bound and admitted, same-id claimant unaffected, Default unchanged, saved On refused with no prompt, missing service fails closed before agent creation, Default without Code Mode unchanged: PASS.
- A first dsh-cron archive at this path (sha256 cba517ff...) contained a skill.js syntax error and was overwritten by the corrected build above (same file; never installed).

## Recheck 2026-11-23 (cron 19cf794, Code Mode 0.12.0 rebased on 0.11.0)

- Baseline: d1b1bcf is an ancestor of HEAD; all 18 files of the installed `~/.dsh/profiles/web/node_modules/dsh-cron` (0.14.5) are byte-identical to `git archive d1b1bcf`.
- Fresh `git archive` copy of 19cf794 (in `dsh-cron/.git/codemode-off-build-19cf794/copy`): 119/119 tests; `npm pack` reproduces the vendor dsh-cron archive byte-for-byte (sha256 `c9c332b3…`, unchanged), 18 members = source; 119/119 with the extracted archive lib.
- Code Mode archive replaced by the rebased 0.12.0 build (sha256 `a48c935a…`; old `4df0b291…` is gone).
- `run.sh` with `CODEMODE_PLUGIN_DIR` = extracted NEW Code Mode archive: explorer PASS (10 scenarios), 8 mutants KILLED, M5b/M9 survived as declared equivalent; explorer on both extracted archives PASS; `cross-archive.mjs` with both extracted archives PASS (all six fields true). Output: `last-run.txt`.
