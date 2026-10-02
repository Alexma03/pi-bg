# Manual test plan

Run this plan in a throwaway Pi session in its **own** Orca terminal, with a **test Run** created from that terminal. Never consume a live coordinator's Run: no `check`, `--ack` or `--wait` against it.

## 0. Setup

1. Create a lab terminal in the Financial Hub folder workspace:
   `orca terminal create --worktree id:<folder id> --title pi-bg-lab --command "mkdir -p /tmp/pi-bg-lab && cd /tmp/pi-bg-lab && pi -e /home/alex/Projects/pi-bg"`.
2. Expected: Pi starts without errors, and the footer shows no pi-bg segment because no Run is bound yet.

## 1. Background tasks

| # | Prompt / action | Expected |
| --- | --- | --- |
| 1.1 | "Run `sleep 20; echo done` in the background, then tell me a joke." | `bg_run` returns at once and the footer shows `⏵ 1 bg`. After about 20 s a `pi-bg` message arrives and the model reacts without a user prompt. |
| 1.2 | "Run `for i in $(seq 1 30); do echo line $i; sleep 1; done; echo READY; sleep 600` with watch until READY." | One match notice arrives after about 30 s; the task is stopped. |
| 1.3 | "Run `exit 7` in the background." | The notice says it FAILED with exit 7. |
| 1.4 | `bg_tail` on 1.2 with `grep: "line 1"` | Only the matching lines are shown. |
| 1.5 | Start `sleep 600`, then `/reload` | The `sleep` process is gone (`pgrep -f "sleep 600"`). |
| 1.6 | Start `sleep 600`, then `kill -9` the Pi process | The group is gone within about 5 s (watchdog). |

## 2. Orca bridge (test Run only)

| # | Prompt / action | Expected |
| --- | --- | --- |
| 2.1 | Ask the lab Pi to run `orca orchestration run-create --objective "pi-bg lab" --json` | About 2 s later the footer shows `orca ◉ run_xxxx`; `/orca-watch` reports `waiting`. |
| 2.2 | From another terminal: `orca orchestration send --to run:<lab run> --type status --subject "lab ping" --body "hello"` | An "Orca delivery" message appears in the lab session and the model processes it and calls `orca_ack`. **No** typed "You have N orchestration messages" pointer appears. |
| 2.3 | Ask the lab Pi to run `orca orchestration check --json` | Blocked by the guard with the explanation. |
| 2.4 | Ask the lab Pi to start a trivial worker: `orca orchestration worker-start --agent pi --worktree path:<read-only child checkout> --spec "Read-only smoke test: send one status message, then worker_done --outcome succeeded. Do not edit anything." --json` | Heartbeats are auto-acked silently (the `/orca-watch` counter grows). The status and `worker_done` arrive as deliveries; the model releases the worker and acks. |
| 2.5 | Send a message while a delivery is pending (do not ack) | No pointer appears. After the ack, the next batch is returned inline in the `orca_ack` result. |
| 2.6 | `/reload` while a delivery is pending | After the reload the same delivery is re-injected with a REPLAY note. |
| 2.7 | In another terminal of the *same pane*… (skip). Instead, `/orca-watch off`, then from the lab bash run `orca orchestration check --wait --timeout-ms 60000 --json &`, then `/orca-watch on` | The footer shows `orca ⚠ another waiter`, then it recovers after that waiter exits. |
| 2.8 | Quit the lab Pi | `pgrep -af "orchestration check"` shows no leftover waiter. |

## 2b. v1.1 fleet and worker (test Run only)

| # | Prompt / action | Expected |
| --- | --- | --- |
| 3.1 | Start a Pi worker told to run `bg_run "sleep 240"`, wait for its notice, then send `worker_done` | While it waits, Orca shows the worker pane "working"; no stalled notice appears; the worker_done arrives normally. |
| 3.2 | Start a Pi worker told to send one status and then **stop without worker_done** | The worker gets one pi-bg reminder (continuation). If it still stops, the coordinator gets an "Orca fleet · STALLED" notice about 3 min later. |
| 3.3 | `orca_watch` on a worker with a note, then let it finish | The settled notice carries the note verbatim. |
| 3.4 | `/reload` the coordinator with open workers | No storm: at most one fleet notice for the current problems. |
| 3.5 | Card | It shows running tasks (last line), the bridge row and the open workers; `/bg card collapse` keeps only problems. |

## 2c. Native watchdog and coordinator tools (test Run only)

1. `orca_config {watchdog: {enabled:true, cadenceMinutes:1, scopeGlobs:[]}}`; start a child worker whose spec includes `Allowed edit surfaces` containing `src/**` and have it change `docs/outside.md`. Expected: one `SCOPE` notice naming the path, with no repeat while it remains present.
2. Start a Pi worker that opens an `ask_user_choice` picker and waits. Expected: one wake notice with the exact question and options; `orca_screen` shows the picker without spinner/footer noise. Also try an Orca `ask` and a final plain-text question; each should wake with its question and visible choices.
3. Repeat a waiting phrase without tool/file progress, then leave a worker's working screen unchanged past the configured threshold. Expected: one `LOOP` or `SCREEN STALL` notice per episode; a fresh status/heartbeat resets no-change timing.
4. Set `orca_config {label:"Lab verification"}`; the card uses it instead of the immutable Run objective and it survives `/reload`.
5. Settle one disposable worker, then call `orca_release {dispatchId}`; use `{all:true}` only when the test Run has multiple reclaimable settled workers. Expected: native release first; terminal close is attempted only for a fresh `exited` verdict, and resolved rows leave the headline counts.
6. Disable the watchdog with `orca_config {watchdog: {enabled:false}}`; no new watchdog findings should be emitted.

## 3. Cleanup

1. Release the lab worker: `worker-release`.
2. Remove any lab worktree.
3. Close the lab terminal.
4. The lab Run can be left as is; it has no workers.
