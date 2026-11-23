# Archives (offline evidence, 2026-11-23; nothing installed)

| Package | Archive | sha256 | Built from |
|---|---|---|---|
| @local/dsh-codemode 0.12.0 | `~/.dsh/profiles/web/vendor/local-dsh-codemode-0.12.0.tgz` | `4df0b2915ef7ab3563d15df51f7e35606e5c6b7651d2524f4e63b5e8633a68ee` | Repos `task/codemode-cron-off-v1` fd343a3 (on main 523b399, includes 0.9.0) |
| dsh-cron 0.14.6-codemode-off.1 | `~/.dsh/profiles/web/vendor/dsh-cron-0.14.6-codemode-off.1.tgz` | `c9c332b321529df98f0e52274648fff9a6bee90f18eb8fe40811b9544d041743` | dsh-cron `task/cron-codemode-off-v1` 1d07680 (baseline d1b1bcf = installed 0.14.5 bytes) |

Checks:
- Code Mode, fresh `git archive` copy per its VERIFY.md (non-temp folder): 72/72 tests, build OK, generated unchanged, package-check PASS, production archive PASS including `exactSessionRunPolicyFromArchive`; 29 archive members byte-identical to source.
- dsh-cron: 18 archive members byte-identical to the lane; 119/119 tests run against the extracted archive lib; explorer PASS against the extracted lib.
- `cross-archive.mjs` (both extracted archives, real Cordis/storage/commands): Off run bound and admitted, same-id claimant unaffected, Default unchanged, saved On refused with no prompt, missing service fails closed before agent creation, Default without Code Mode unchanged: PASS.
- A first dsh-cron archive at this path (sha256 cba517ff...) contained a skill.js syntax error and was overwritten by the corrected build above (same file; never installed).
