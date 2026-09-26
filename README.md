# pi-bg

Background tasks for [Pi](https://pi.dev) that wake the model when they finish. It also includes a first-class bridge to the [Orca](https://github.com/stablyai/orca) orchestration mailbox for coordinator sessions.

It has no runtime dependencies: Pi supplies `@earendil-works/pi-coding-agent`, `pi-tui` and `typebox` to extensions. It adds its own tools and leaves Pi's built-in `bash` tool unchanged.

## Install

```bash
pi -e /home/alex/src/pi-bg            # try it for one session
pi install /home/alex/src/pi-bg       # add it to ~/.pi/agent/settings.json
```

Restart or `/reload` running sessions to pick it up.

## Background tasks

| Tool | What it does |
| --- | --- |
| `bg_run {command, cwd?, label?, timeout_s?, watch?}` | Starts `bash -c <command>` in its own process group and returns at once with an id and a log path. |
| `bg_status {id?}` | Lists tasks and their state. |
| `bg_tail {id, lines?, grep?}` | Shows a bounded, sanitized and redacted tail of the log. |
| `bg_cancel {id}` | TERM to the group, then KILL after 3 s. No completion notice follows. |

- **Completion.**
  - When a task exits, the model receives a `pi-bg` message with the exit code or signal, the duration, the last lines and the log path.
  - The message is sent with `deliverAs: "steer"` and `triggerTurn: true`. An idle session starts a turn at once; a busy one sees the message before its next model call.
  - Notices that settle together are batched into one message.
- **Watch.** `watch: {pattern, flags?, mode?, keep_running?, max_events?}` tests each output line against a JavaScript regex.
  - `until` (the default) notifies on the first match and then stops the task, unless `keep_running` is set.
  - `each` notifies per match, coalesced over 2 s, up to `max_events` notices (default 20). The exit is always reported.
  - Watches default to a 30-minute deadline. Plain tasks have no deadline unless `timeout_s` is set; the maximum is 24 h.
- **Lifetime.** Tasks never outlive the Pi runtime that started them.
  - `session_shutdown` (quit, `/reload`, new, resume, fork) terminates every group.
  - A `process.on("exit")` hook sends KILL as a fallback.
  - A watchdog in the spawn wrapper terminates the group within about 2 s if Pi is killed or crashes.
- **Logs.** Logs live in `~/.local/state/pi-bg/logs/<session>/` (mode 0600) and are pruned after 7 days. Anything copied from a log to the model or the terminal is stripped of escape sequences, redacted for common credential shapes, and size-bounded.
- **Commands.** `/bg` lists tasks. `/bg kill <id|all>` stops them.

## Orca mailbox bridge

The bridge is active only in an interactive Pi session inside an Orca terminal (`ORCA_TERMINAL_HANDLE` is set), and never in gentle subagent children. It works as follows.

1. **Detect.** At session start, and again after any bash `orca orchestration run-create|run-use`, the bridge runs `orca orchestration run-current`. While no Run is bound it re-checks every 2 minutes.
2. **Wait.** It keeps exactly one `orca orchestration check --wait --json` child, **without `--types`**. Orca 1.4.212 does not type its "You have N orchestration messages" pointer while an unfiltered waiter exists, or while a delivery is outstanding. Both states are covered, so the pointer never appears.
3. **Heartbeats.** A heartbeat-only batch is acknowledged silently: the next wait runs as `check --ack <id> --wait`.
4. **Deliver.** Any other batch becomes an **Orca delivery** message (steer + triggerTurn).
   - It carries the delivery id, the Run, and every non-heartbeat message with its type, sender, subject, body, payload and a reply hint.
   - The full batch is saved as JSON under `~/.local/state/pi-bg/orca/`.
   - The delivery stays *pending*; no new wait starts until it is acknowledged.
5. **Ack.** After processing every message, the model calls **`orca_ack {deliveryId}`**.
   - The bridge runs a synchronous `check --ack`. If Orca already holds the next batch, it is returned inline in the tool result.
   - Otherwise the waiter is re-armed.
   - A single reminder is sent if a delivery stays pending for more than 10 minutes.
6. **Guard.** While the bridge is active, a consuming `orca orchestration check` or `orca-wait` in the bash tool is blocked, with an explanation. `check --peek` and `check --all` stay allowed.
7. **Failures.** Errors never cause a silent double delivery.

   | Failure | Behaviour |
   | --- | --- |
   | `waiter_exists` | Back off 15 s → 120 s. The footer shows "another waiter". |
   | Transport error or Orca restart | Back off 1 s → 60 s with jitter. |
   | `consumer_fenced`, `stable_pane_required`… | Stop, then re-detect the Run. |
   | Replayed delivery (after a failed ack or a `/reload`) | Re-injected with a visible **REPLAY** note. |

- **Inspect.** `orca_inbox` shows the bridge state and the pending delivery, read-only.
- **Commands.**
  - `/orca-watch` shows the status.
  - `/orca-watch on` and `/orca-watch off` switch the bridge.
  - `/orca-watch <run_id>` consumes that Run explicitly with `--run`.

The footer segment reads `⏵ 2 bg · orca ◉ run_8da5` while waiting, `orca ◆ ack pending 2m05s` while a delivery is pending, and `orca ⚠ retry 30s` during backoff.

### Environment

| Variable | Effect |
| --- | --- |
| `PI_BG_DISABLE=1` | Load nothing. |
| `PI_BG_ORCA=0` | Background tasks only; no Orca bridge or tools. |
| `PI_BG_ORCA_BIN` | Path of the `orca` CLI (default `orca` on PATH). |
| `PI_BG_STATE_DIR` | State root (default `$XDG_STATE_HOME/pi-bg` or `~/.local/state/pi-bg`). |

## Development

```bash
mise exec -- pnpm install
mise exec -- pnpm test        # unit tests plus real-process and fake-orca integration tests
mise exec -- pnpm typecheck
```

- The protocol decisions live in `lib/orca/machine.ts`, a pure reducer. `lib/orca/bridge.ts` only executes its effects.
- See `docs/manual-test-plan.md` for the live Orca test.
