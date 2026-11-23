# Installed dsh-cron 0.14.5 baseline

`installed-0.14.5.sha256` hashes every authored file of the installed package
`~/.dsh/profiles/web/node_modules/dsh-cron` (version 0.14.5; no nested
node_modules; dependencies and runtime data excluded), captured 2026-11-23.

The baseline commit starts from tag `v0.14.5` (d711f3e) and copies those exact
bytes. 17 of 18 shipped files were already byte-identical to the tag. One differs:

- `lib/index.js` — the installed copy carries a local maintenance patch
  ("dsh-maintenance 0001": `ctx.agents.roots()` was removed in DSH 0.2.1; rc.5
  identifies roots by session origin). The baseline takes the installed bytes.

Fork-only work after v0.14.5 on `main` (executor hardening, single-flight
recheck, verify/single-flight) is NOT in the installed package and is not part
of this baseline. Tests, assets, examples and README screenshots are tag files
that are not shipped; they are retained unchanged.

Check: `shasum -a 256 -c verify/baseline/installed-0.14.5.sha256` from the
baseline commit must print 18 OK lines.
