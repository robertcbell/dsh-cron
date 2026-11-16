# DSH cron

DeepSeek Harness scheduled-jobs plugin. Read `README.md` for trigger, dispatch,
authorization and persistence contracts. Runtime modules are in `lib/`;
`npm test` runs the Node test suite (`node --test test/*.test.js`).

Preserve at-most-once dispatch, explicit time zones, overlap/misfire policies
and startup repair of interrupted runs. Dispatch state belongs in the `cron`
storage domain, not session event logs.

Jobs execute as host administration. Keep manual-spec authorization digests,
quarantine and dispatch/delivery rechecks intact; do not weaken permission
checks to exercise a job. Preserve the explicit environment-name allowlist.
Installing, enabling or triggering jobs can execute commands or spend model
quota, and is separate from source or documentation verification. The public
npm package named `dsh-cron` is unrelated; follow this repository's install source.
