# pi-bg handoff (2026-09-27)

pi-bg is a Pi extension with two parts:

- background tasks (`bg_run` / `bg_status`) that wake the model when they finish;
- an Orca mailbox bridge. It keeps one waiter with no `--types`, so the typed pointer "You have N orchestration messages" goes away.

## Where things are

| Path | Branch / head | State |
| --- | --- | --- |
| `/home/alex/Projects/pi-bg` | `main` `49cfa1f` | v1; Judgment Day APPROVED; 59 tests |
| `/home/alex/Projects/pi-bg-v11` (git worktree) | `feat/v1.1` `1582da8` | Adds fleet watch, the worker-side reminder and the UI card; 98 tests; lab-proven. Not merged into `main` yet. |

Both paths moved from `~/src` on 2026-09-27, and the worktree links were repaired. The repo has no remote.

## Research and evidence (`docs/research/`)

- `pi-background-session-brief.md`: the original problem statement.
- `pi-background-research.md`: the design, the Orca 1.4.212 mailbox semantics, and the live lab results for v1 and v1.1.
- `pi-bg-judgment/RESULT.md`: the Judgment Day ledger and verdict.
- `orca-extension-points.md` and `orca-22868-comment-draft.md`: the comment posted upstream on stablyai/orca#22868.

## Next steps

1. Review `feat/v1.1`, then merge it into `main`.
2. Try it for one session: `pi -e /home/alex/Projects/pi-bg`.
3. Install it for good: `pi install /home/alex/Projects/pi-bg`. This adds it to `~/.pi/agent/settings.json` packages; today it is NOT installed.
4. Pending work:
   - A-017: heartbeat-derived worker liveness.
   - The Gentle fullscreen header drops extension `setStatus`, so the status lives in the sidebar Integrations card and the widget card.
5. Learned on 2026-09-27: a Pi worker only reads Orca steering between tool calls, so long blocking waits delay coordinator messages. pi-bg's worker-side reminder could enforce waits of 3 minutes or less.
