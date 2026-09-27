# Auto-background long bash commands; click to collapse cards

Evidence (sessions of the last 4 h, pi-bg 9ca68db): 2 945 bash calls; 83 took over 1 min and 15 over 5 min; 348 min spent blocked in bash. Most were in the coordinator (gh pr checks loops, --watch, deploys, ansible) while Orca deliveries waited. The bash timeout the model sets is a poor signal: 20 of 90 calls with timeout > 300 took under 10 s.

User decisions (2026-09-28):
- Every bash command still running after 10 s moves to the background by itself, and the instructions are reinforced.
- Clicking a card collapses it to one row (title plus summary); clicking again expands it. Each card collapses on its own.

## Tasks
- [ ] 1. Auto-background: in any interactive session (not gentle subagent children, not print mode), bash commands run as attached pi-bg tasks and move to the background after 10 s. The existing worker mail detach still applies. Orca lifecycle commands stay in the foreground. The bash timeout, or 30 s without one, keeps applying.
- [ ] 2. Reinforce the instructions: bash vs bg_run, loops/watch/deploys, and the 10 s auto-move.
- [ ] 3. Click to collapse each card to one summary row (pi-tui MouseRegion); verify live in fullscreen.
- [ ] 4. README, full suite, live verification in the lab, review, commits.
