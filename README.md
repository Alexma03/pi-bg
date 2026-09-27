# pi-bg

Background tasks for [Pi](https://pi.dev) that wake the model when they finish. It also includes a first-class bridge to the [Orca](https://github.com/stablyai/orca) orchestration mailbox for coordinator sessions.

It has no runtime dependencies: Pi supplies `@earendil-works/pi-coding-agent`, `pi-tui` and `typebox` to extensions. It adds its own tools and leaves Pi's built-in `bash` tool unchanged.

## Install

```bash
pi install git:github.com/Alexma03/pi-bg      # personal install (~/.pi/agent/settings.json)
pi update                                     # pull the latest main later
```

For development, point Pi at a local checkout instead: `pi -e ./pi-bg` for one session, or `pi install ./pi-bg`.

Restart or `/reload` running sessions to pick it up.

## Background tasks

**Automatic background.** In an interactive session, a `bash` command still running after **10 s** moves to the background by itself. The bash call returns at once saying so, the command keeps running as a pi-bg task, and its ordinary notice arrives when it ends. Its bash `timeout` (or 30 s without one) still applies. Measured before this change: agents spent 348 min in 4 h blocked in bash calls (CI polling loops, deploys), while Orca deliveries waited. Orca lifecycle commands (`orca …`) stay in the foreground. Gentle subagent children and non-interactive runs are left alone. `PI_BG_AUTO_BACKGROUND_S` changes the threshold (`0` turns it off), and `PI_BG_ATTACH=0` turns attaching off entirely.

`bg_run` is for commands that take **10 seconds or more**, or never end on their own (test suites, builds, installs, deploys, CI and log watches). It is also for starting **several such commands in parallel**, one `bg_run` each. Near-instant commands (`cd`, `cat`, `ls`, `grep`, `git status`…) belong to the ordinary `bash` tool. The tool description tells the model this. When a task still ends in under 2 s, its notice reminds the model to use `bash` for commands that fast.

| Tool | What it does |
| --- | --- |
| `bg_run {command, timeout_s, cwd?, label?, watch?}` | Starts `bash -c <command>` in its own process group and returns at once with an id and a log path. `timeout_s` is required (1 s to 24 h), and a missing `cwd` is refused before anything starts. |
| `bg_status {id?}` | Lists tasks and their state. |
| `bg_tail {id, lines?, grep?}` | Shows a bounded, sanitized and redacted tail of the log. |
| `bg_cancel {id}` | TERM to the group, then KILL after 3 s. No completion notice follows. |

- **Completion.**
  - When a task exits, the model receives a `pi-bg` message with the exit code or signal, the duration, the last lines and the log path.
  - A busy session gets it as a steer message, seen before its next model call.
  - An idle session gets it for its next turn, plus a short prompt that starts that turn (`⟳ pi-bg: 1 background task update`). A turn started by an extension message would skip `before_agent_start`, so extensions that add to the system prompt there (Gentle Shell) would be missing, and claude-bridge refuses such a turn. Delivery and fleet messages wake the session the same way.
  - Notices that settle together are batched into one message.
- **Watch.** `watch: {pattern, flags?, mode?, keep_running?, max_events?}` tests each output line against a JavaScript regex.
  - `until` (the default) notifies on the first match and then stops the task, unless `keep_running` is set.
  - `each` notifies per match, coalesced over 2 s, up to `max_events` notices (default 20). The exit is always reported.
- **Deadline.** Every task has one: `timeout_s` is required (1 s to 24 h), so a forgotten command cannot run away during a long Run. When it is reached the group is stopped and a timeout notice is sent.
- **Lifetime.** Tasks never outlive the Pi runtime that started them.
  - `session_shutdown` (quit, `/reload`, new, resume, fork) terminates every group.
  - A `process.on("exit")` hook sends KILL as a fallback.
  - A watchdog in the spawn wrapper terminates the group within about 2 s if Pi is killed or crashes.
- **Logs.** Logs live in `~/.local/state/pi-bg/logs/<session>/` (mode 0600) and are pruned after 7 days. Anything copied from a log to the model or the terminal is stripped of escape sequences, redacted for common credential shapes, and size-bounded.
- **Commands.** `/bg` lists tasks. `/bg kill <id|all>` stops them.

## Orca mailbox bridge

The bridge is active only in an interactive Pi session inside an Orca terminal (`ORCA_TERMINAL_HANDLE` is set), and never in gentle subagent children. It works as follows.

The coordinator tools (`orca_ack`, `orca_inbox`, `orca_workers`, `orca_watch`) are active in such a session from the start, even before a Run is bound. Some providers, such as claude-bridge, fix the tool list for a whole turn. Without this, a delivery that arrives in the same turn as `run-create` could not be acknowledged until the next turn. Without a Run the tools only answer that nothing is bound.

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
6. **Guard.** While the bridge is active, a consuming `orca orchestration check` or `orca-wait` in the bash tool is blocked, with an explanation. `check --peek`, `check --all` and `--help` stay allowed. Text that only mentions a check, in a heredoc body or a quoted string, is not blocked.
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

The footer shows `⏵ 2 tareas` for tasks and a separate Orca segment. The Orca segment reads `orca ◉ escuchando` while waiting, `orca ◆ sin procesar 2m05s` while a delivery is pending, and `orca ⚠ reintento 30s` during backoff.

### Fleet watch (coordinator)

While a Run is bound, pi-bg polls `worker-list --run` and `task-list --run` every 30 s. These calls are read-only, use explicit paging, and never touch the mailbox. pi-bg then sends an **Orca fleet** message on these transitions:

- **stalled**: the worker is in progress but its activity has been `done` or `idle` for 3 min, or its status is stale, and it has not sent `worker_done`;
- **no change**: the worker reports working, but what it is doing (read every 10 s from its terminal, running clocks ignored) has not changed for 10 min. Waiting on its own background task does not count;
- **blocked**: an interactive prompt has been open in its terminal for more than 1 min;
- **exited**: the process exited without `worker_done`;
- **attention**: Orca reports input, approval, failure or interruption;
- **to release**: the worker settled and its terminal is still not released after 3 min;
- **fleet idle**: nobody is working while work is open;
- **ready tasks**: tasks whose dependencies are done have no worker.

Notices are coalesced over 5 s. At most 4 notices per 10 min start a turn; the rest wait for the next turn. Terminals taken over by a human are not reported as stalled or as closure debt. **The model decides what to do; pi-bg never nudges workers.**

- `orca_workers {all?, refresh?}` shows the fleet table: outcome, activity, agent and model, time since dispatch, and a `now:` line with what each open worker is doing and how long that has been unchanged.
- `orca_watch {dispatchId, on?, note?}` adds events (`settled`, `any`) plus a note that comes back verbatim in the notice. Notes survive `/reload`.

While a `bg_run` task runs, pi-bg emits `subagent:async-started` and `subagent:async-complete` on `pi.events`. Orca's Pi status extension then keeps the pane "working". A worker waiting on a gate is therefore not mistaken for a stalled one, and the Orca UI shows it as busy.

### Worker side

A Pi session that receives an Orca worker preamble (`=== TASK ===` with `--task-id` / `--dispatch-id`) is tracked model-free:

- `worker_done` counts only when the tool result shows Orca accepted it.
- If a completed turn ends without it, pi-bg appends a reminder and continues the turn (`agent_before_settle`).
- Reminders are limited to 2 per input, at least 10 min apart.
- There is no reminder while bg tasks run or messages are queued, or after the user aborts the turn.

**Coordinator mail.** Orca does not interrupt a busy worker: `send --to dispatch:<id>` only enqueues, and the worker sees it only when it runs `check`. pi-bg closes that gap for dispatched Pi workers until they send `worker_done`:

- It peeks the worker's own mailbox every 15 s (`check --terminal <handle> --peek`, read-only, so nothing is marked read).
- On new coordinator mail it sends the model a steer message with the messages and the exact `check` to run, which marks them read. If the mail stays unread, it reminds up to 2 times, 5 min apart.
- **Blocking commands move to the background.** A worker's bash commands, except `orca …` lifecycle calls, run as *attached* pi-bg tasks: the bash tool runs a small attach client that streams the output and returns the exit code as usual. When mail arrives, pi-bg detaches them:
  - the bash call returns at once with "Moved to the background as bgN";
  - the command keeps running, and its ordinary pi-bg notice arrives when it ends;
  - the model reads the message right away instead of after the command.
- Every attached command has a deadline, also after it moves to the background: the bash call's own `timeout`, or **30 s** when it has none (a call without a timeout is expected to be short). When it is reached the command is stopped and the model is told to rerun it with a larger `timeout`. `bg_status` shows each task's deadline.
- A bash abort still stops the command.
- `PI_BG_ATTACH=0` turns attaching off, and `PI_BG_WORKER_MAIL=0` turns the mail watch off.

A dispatched worker loses the coordinator tools as soon as its preamble arrives, unless it binds a Run itself. It keeps following its preamble's `check --terminal`. Gentle subagent children always get consuming checks blocked, because they share the lead's terminal identity.

### UI

- **Cards.** Two separate cards sit above the editor. Each appears only when it has something to show, and both are in Spanish.
  - **"⏵ Segundo plano"** lists background work only: `bg_run` tasks, plus a worker's bash command once it has moved to the background. A command the agent is still waiting on does not appear, and neither does an internal `bgN` id. The time comes first, so a long command never hides it:
    - `⏵ 3m21s de 30m00s · infra verify.sh · ok 12/40`: running for 3m21s of its 30-minute deadline, then its label or command (clipped) and its last output line;
    - `✔ terminó bien · 20s · prueba idle`: finished ones lead with a plain outcome ("terminó bien", "falló (código 7)", "encontró el patrón", "tiempo agotado"…).
  - **"⇄ Orca · <objective>"** names the Run by its objective and shows one entry per open agent.
    - First line: `agente ·`, the task title, its state ("trabajando", "esperando", "parado 5m sin terminar", "esperando una respuesta en su terminal", "terminó · falta cerrarlo"), the time since dispatch, the agent and the model. When no `--model` was passed, a Pi worker shows the `defaultModel` from its project settings, falling back to the personal ones, marked "(por defecto)". No model is guessed for a worker dispatched into an existing terminal (`--terminal`).
    - Second line, dimmed (`↳`): what the worker is doing now, refreshed every 10 s from the tail of its terminal (`worker-read`, sanitized and redacted). It shows a background task it is waiting on, else its last tool action (`$ command`, `read file`, `bg_run · …`), else the last line it wrote. A tool call whose arguments are still being written (`write ...`, `$ ...`) is described in words, followed by what the agent said just before: `escribiendo un fichero · Writing the report now.`
    - Agent, model and start time come from one `worker-show` per dispatch; the objective comes from `run-show`. All these reads are read-only; the first two are cached.
    - The card is hidden while the session orchestrates no agent and the bridge is just listening.
    - A bridge row appears only when something needs attention: unprocessed messages, a retry, or a lost Run.
  - `/bg card on|off|collapse` controls both cards. The footer also has one segment for each (`⏵ 2 tareas`, `orca ◉ escuchando`).
- **Delivery messages.** They render one glyph per message type (`worker_done` ✔/✖ by outcome, `question` ?, `escalation` ⚠).
- **Tool results.** They are one line unless expanded.
- **Live state.** Wake messages end with a short live-state block (running tasks, pending delivery, fleet summary). It is not added to the system prompt, which keeps the prompt cache stable.

### Environment

| Variable | Effect |
| --- | --- |
| `PI_BG_DISABLE=1` | Load nothing. |
| `PI_BG_ORCA=0` | Background tasks only; no Orca bridge or tools. |
| `PI_BG_ORCA_BIN` | Path of the `orca` CLI (default `orca` on PATH). |
| `PI_BG_CARD=off` | Start with the card hidden. |
| `PI_BG_WORKER_MAIL=0` | Workers do not watch their mailbox for coordinator mail. |
| `PI_BG_ATTACH=0` | Bash commands run the ordinary way (no automatic background, no detaching on coordinator mail). |
| `PI_BG_AUTO_BACKGROUND_S` | Seconds after which a running bash command moves to the background (default 10; `0` = never). |
| `PI_BG_STATE_DIR` | State root (default `$XDG_STATE_HOME/pi-bg` or `~/.local/state/pi-bg`). |

## Development

```bash
mise exec -- pnpm install
mise exec -- pnpm test        # unit tests plus real-process and fake-orca integration tests
mise exec -- pnpm typecheck
```

- The protocol decisions live in `lib/orca/machine.ts`, a pure reducer. `lib/orca/bridge.ts` only executes its effects.
- See `docs/manual-test-plan.md` for the live Orca test.
