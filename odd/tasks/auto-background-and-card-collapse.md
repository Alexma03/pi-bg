# Auto-background long bash commands; click to collapse cards

Evidence (sessions of the last 4 h, pi-bg 9ca68db): 2 945 bash calls; 83 took over 1 min and 15 over 5 min; 348 min spent blocked in bash. Most were in the coordinator (gh pr checks loops, --watch, deploys, ansible) while Orca deliveries waited. The bash timeout the model sets is a poor signal: 20 of 90 calls with timeout > 300 took under 10 s.

User decisions (2026-09-28):
- Every bash command still running after 10 s moves to the background by itself, and the instructions are reinforced.
- Clicking a card collapses it to one row (title plus summary); clicking again expands it. Each card collapses on its own.

## Tasks
- [x] 1. Auto-background: in any interactive session (not gentle subagent children, not print mode), bash commands run as attached pi-bg tasks and move to the background after 10 s. The existing worker mail detach still applies. Orca lifecycle commands stay in the foreground. The bash timeout, or 30 s without one, keeps applying. Commit e9309af; live-verified in the lab (sleep 25 moved after 10 s, notice arrived).
- [x] 2. Reinforce the instructions: bash vs bg_run, loops/watch/deploys, and the 10 s auto-move. Commit e9309af.
- [x] 3. Click to collapse each card to one summary row (pi-tui MouseRegion); verify live in fullscreen. Live: real clicks in the lab fold (height 4 → 2) and unfold. A component must claim the left `press`, or fullscreen never synthesizes the `click`. Commit 4708e92.
- [x] 4. README, full suite (133/133), live verification in the lab, reviews, commits e9309af and 4708e92.

## Follow-ups (review advisories, non-blocking)
- The folded Orca summary does not name bridge backoff/fenced states or ready tasks without an agent (review-6ed34df5f135ea24, card.ts:232).
- The idle-wake harness test does not cover the whole lifecycle (review-784a8d0370534edf).
