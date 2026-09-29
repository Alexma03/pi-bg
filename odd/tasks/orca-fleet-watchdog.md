# Native Orca fleet watchdog and worker workflow fixes

## Goal
Replace the coordinator's external scope/screen watchdog with model-free pi-bg supervision, correct fleet-card model/settlement/activity signals, and reduce common coordinator actions.

## Constraints
- Operate only in this worktree; never write to worker repositories or inspect/mutate the live production Run beyond read-only CLI discovery.
- Keep watchdog state under pi-bg's configured state directory; no model calls; notices only for new findings, with deduplication/cooldown.
- Preserve explicit coordinator control: watchdog observes and reports but never steers, releases, closes, or changes worker files.
- Test behavior at pure module and fake-Orca seams using `node --test`; run `pnpm test` and `pnpm typecheck`.
- No dependency upgrades, gentle-ai review, or RDD.

## Work units
1. Correct model evidence order (launch flag, terminal status bar, Pi profile default) and use recent dispatch heartbeat/status activity in no-change timing.
2. Add native watchdog detectors for scope (committed and uncommitted changes vs parsed/configured allowed surfaces), unchanged working screens, repetitive waiting loops, interactive prompts, and settled/exited workers awaiting closure. Persist findings/config in the pi-bg state directory and expose safe configuration.
3. Add explicit `orca_release`, short `orca_screen`, and a short Run label override; ensure resolved/settled workers disappear from headline counts. Never perform lifecycle cleanup without an explicit tool call.
4. Document the simplification proposal, selected wins and follow-ups; update README and manual test plan.
5. Verify, commit in reviewable Conventional Commit work units, push once, and open one PR using the owner-authorized user-request reference and approved size exception; do not merge.

## Verification evidence
- Test-first for model selection, activity timestamps, release fallback, glob matching, loop/stall/prompt detection and deduplication.
- Fake Orca integration verifies tool boundaries and that watchdog/release paths do not access worker repos for writes or consume coordinator mail.
- Local acceptance: `pnpm test`, `pnpm typecheck`.

## Delivery strategy
Single PR only, per the owner's explicit one-branch/one-PR decision and approved `size:exception`; split commits by behavior. The owner authorized the current GitHub CLI session for one push and PR, directed no issue link, and selected `Refs: user request 2026-09-29 (orca-fleet-watchdog)` as the body reference.

## Completed evidence
- Feature work unit: `a35d0a5 feat(orca): add model-free fleet watchdog and worker tools`.
- `pnpm test`: 162/162 passed; `pnpm typecheck`: passed.
- Fake-Orca integration covers answer-aware picker notices, trimmed `orca_screen`, native release with exited-only fallback, persisted label/watchdog config, and read-only scope scans.
- Live Orca/production Run test: not run; no production worker lifecycle or mailbox was touched.
- Delivery: one PR with the approved size exception; no merge.
