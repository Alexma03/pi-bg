# Background deadline fix and bg_run guidance

## Goal
Stop pi-bg from killing un-timed bash commands at 30 s, make the bg_run tool description self-sufficient on hosts that drop promptGuidelines, and remove misleading text from rewritten bash commands. Then review the Orca orchestration surface read-only.

## Constraints
- Preserve Pi bash semantics: a bash call without `timeout` has no pi-bg deadline while it stays in the foreground.
- A command that moves to the background without an explicit timeout gets a bounded default deadline (30 min) so it cannot run away.
- Test-first with `node --test`; acceptance `pnpm test` and `pnpm typecheck`.
- No push, PR or merge without the owner's decision.

## Tasks
- [x] 1. Deadline: attached bash without timeout gets no deadline in the foreground; on detach (slow or mail) it gets a 30 min default. Explicit timeouts unchanged.
- [x] 2. Guidance: compact, self-sufficient `bg_run` description (decision rule incl. waiting/CI, 2–10 s gap defaults to bash, auto-background fact, no polling, watch, generous timeout_s); slimmer promptGuidelines without duplication.
- [x] 3. Rewritten bash command comment: mention the coordinator only when an Orca worker is active.
- [x] 4. Read-only review of the Orca orchestration surface; report findings.

- [x] 5. Orca guards: M2 `/orca-watch` arg validation; M3 `orca_watch` unknown dispatchId; L1 inject only if still pending; L2 ack rejects after dispose.
- [x] 6. Fleet notices: H1 never park exited/attention/fleet_idle; H2 dedupe per dispatch by priority; H3 release grace from watchdog config; H4 keep notified across stop/watch of same Run; M6 no release/finished for history on first poll.
- [x] 7. Watchdog persistence: H5 per-Run state file + unique tmp; M1 await a shared load promise.
- [x] 8. Tool activation: M5 orca tools only in TUI sessions; L4 compare with getActiveTools; L3 status line after repeated peek failures.
- [x] 9. Orca tool texts: mailbox rule in orca_ack description, drop duplicates; orca_release XOR; parameter descriptions; optional deliveryId; README L5.
- [x] 10. Merge orca_inbox into orca_workers and orca_label+orca_watchdog into orca_config.
- [x] 11. Delegation rule in the system prompt (before_agent_start): bg_run / gentle subagent (bounded, one front) / Orca worker = new Pi orchestrator (several fronts, own plan and subagents) / orca-cli handoff; Orca workers keep using gentle subagents.

## Evidence
- Task 1: `80e865a` — RED 3 failing (attach detach default, worker mail, worker attach); GREEN 163/163, tsc ok.
- Task 2: `ed4b486` — bg_run description+guidelines 2969 → 1523 chars; tsc ok.
- Task 4: explorer report (read-only). Verified: H1 parked fleet notices never retried; H2 duplicate notices per condition; H3 releaseGraceMinutes dead for fleet release; H4 fleet state reset on fence/off-on; H5 shared watchdog.json; M1 load race; M2 /orca-watch typo kills waiter (spot-checked pi-bg.ts:1032); M3 orca_watch unknown dispatchId; M5 orca tools in non-TUI; L1 inject after pending changed; L2 ack hang after dispose; L3 silent peek failures; L5 README drift. Ack rule only in promptGuidelines (dropped by description-only hosts).
- Task 3: `add3f33` — RED harness auto-background comment; GREEN 163/163, tsc ok.
- Task 5: `74a5aa6` — RED 3 (late inject, ack after dispose, typo/unknown dispatch); GREEN 165/165, tsc ok. Worker subagent failed (model anthropic/claude-sonnet-5-5 errors on first turn); done inline.
- Task 6: `bf75c9f` — RED 4 (dedupe module missing, historic release, off/on repeat, release grace); GREEN 174/174, tsc ok.
- Task 7: `f08c81b` — RED 2 (shared label overwritten, setting lost during load); GREEN 176/176, tsc ok.
- Task 8: `113eeb6` — RED 3 (print-mode tools, dropped tools, peek failure status); GREEN 179/179, tsc ok.
- Task 10: `54f6312` — RED 2 harness (merged tool surface); GREEN 179/179, tsc ok.
- Task 9: `e25a518` — RED 2 (ack without id, settled note); GREEN 180/180, tsc ok.
- Task 11: `dfbe57f` — RED 2 (module missing, prompt injection); GREEN 184/184, tsc ok.
