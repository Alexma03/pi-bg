# Pi background tasks + Orca mailbox bridge: research and design

Date: 2026-09-26. Environment: Pi 0.87.1, Orca 1.4.212 (Linux AppImage), Node 26.10 via mise.
Decision (user): build our own package **`pi-bg`**. Orca is a first-class feature, alongside generic background tasks. Tasks are always killed on exit and `/reload`.

## 1. Findings

### 1.1 Pi 0.87.1 extension API: everything needed exists

Sources: `~/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`, `dist/core/agent-session.js` (`sendCustomMessage`), `docs/extensions.md`.

- **`pi.sendMessage({customType, content, display, details}, {triggerTurn, deliverAs})`**:
  - Idle + `triggerTurn: true` starts a turn immediately.
  - Streaming + `deliverAs: "steer"` is injected before the next LLM call.
  - Streaming + `"followUp"` is drained only when the run loop stops. gentle-shell issue #867 measured delays of 50–58 minutes when the parent keeps calling tools.
  - `"nextTurn"` parks the message until the next user turn.
  - **`steer` + `triggerTurn: true` is the right wake mode.** gentle-shell uses it for background subagent completions.
- Custom messages are non-user. `registerMessageRenderer(customType, fn)` controls the TUI look. They are stored in the session and sent to the model as custom content.
- UI: `ctx.ui.setStatus(key, text)` adds a footer segment; `setWidget` adds a block above or below the editor; `notify` shows a toast. Guard with `ctx.hasUI`.
- Lifecycle:
  - `session_start` fires with reason startup/reload/new/resume/fork.
  - `session_shutdown` fires with reason quit/reload/new/resume/fork.
  - Docs: do not start processes in the factory; start them in `session_start`; release them in an idempotent `session_shutdown`.
  - `/reload` replaces the runtime, so old in-memory state is gone.
- `pi.on("tool_call")` can block a tool call, and `tool_result` can observe results. We use these to guard bash `orca orchestration check`.
- Pi supplies `@earendil-works/pi-coding-agent`, `pi-tui`, `pi-ai` and `typebox` as virtual modules, so an extension needs **zero runtime dependencies**. A local-path package loads without copying (`pi install ./pkg` or `pi -e ./pkg`).

### 1.2 Orca 1.4.212 mailbox semantics (verified in the shipped `app.asar`, `out/main/index.js`)

- **When the pointer is typed.** "You have N orchestration messages…" (`fP(count, handle, cli)`) is written to the PTY by the pending-message path. It is skipped (`nsa()`) when **any** of these holds:
  1. the mailbox has an **outstanding (unacked) delivery** (`hasOutstandingMailboxDelivery("run:<id>")`);
  2. an active waiter's `typeFilter` covers the message type, or a waiter has **no type filter**;
  3. the messages are already read.

  A waiter **without `--types`** suppresses the pointer for every type. Today's `orca-wait` uses `--types …`, which does not list every type, and it leaves gaps between invocations. That is why pointers still appear for `status` or unlisted types. This also refines #19541: on 1.4.212 an outstanding delivery suppresses the pointer.
- **Consuming check.**
  - The Run is resolved from the caller's pane (`getCurrentRunForPane`). The CLI reads `ORCA_TERMINAL_HANDLE` / `ORCA_PANE_KEY` from the environment, so a child process of the Pi coordinator inherits the coordinator's identity.
  - `check` returns the oldest outstanding FIFO delivery, up to 50 messages and never filtered by type, and replays it until ack.
  - `--ack X` acknowledges first, then returns or waits for the next delivery. `--ack X --wait` does this atomically in one call.
- **Waiter rules.**
  - `waitForMessage(run:<id>, {exclusive: true})` allows one waiter per Run; a second one gets `waiter_exists`.
  - If the Run's consumer generation changed (`run-create` / `run-use` elsewhere), the call returns `consumer_fenced`.
  - When the CLI process dies, the signal aborts and the waiter is released.
  - Keepalive JSON lines go to stderr every 15 s.
- **Result shape.** `{ok, result: {runId, deliveryId|null, messages[], count, replayed, acknowledged, timedOut, cancelled, connectionLost}}`. Errors look like `{ok: false, error: {code, message}}`. Messages are DB rows: `id, type, from_handle, to_handle, subject, body, payload, priority, thread_id, created_at, sequence…`.
- **Run detection.** `orca orchestration run-current --json` returns `{result: {run: null | {...}}}`, is read-only, and takes about 0.14 s.
- **Worker mailboxes.** `check --terminal <handle>` uses the same model (`getOrCreateMailboxDelivery`, replay until ack) on `dispatch:<id>`. The same pointer rules apply, so the bridge design transfers to workers.
- **Upstream (read-only).**

  | Item | State | Summary |
  | --- | --- | --- |
  | #16822 | open | Asks for a switch to disable the pointer; there is no response. |
  | #19541 | open | Asks for a quiet mode or a `--nudge-types` filter. |
  | #14897 | open | Runtime nudges for silent dispatches. |
  | #13185 | open | Pi in the native Chat UI. |
  | PR #15451 | draft, stale since 2026-08-19 | Supervises fresh Pi *workers* over RPC. Not the coordinator inbox. |

  Nothing upstream solves the coordinator case for Pi.

### 1.3 Existing Pi packages (npm, read with `npm pack` into `/tmp/pi-bg-survey/pk`)

| Package | Version / updated | Pi 0.87 compat | Wake mode | Process model | Orca | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| pi-background-tasks | 2.6.7 / 2026-09-26 | **No** (peer ≤0.84) | followUp | — | no | 66k LOC. Delegated agents and attested runs; calls api.anthropic.com, chatgpt.com and the npm registry. Too broad. |
| pi-better-background-tasks | 0.2.17 / 2026-09-26 | peer `*` | followUp | tmux-backed | no | Needs tmux. Slow wake mode. |
| @fractaal/pi-agentic-processes | 0.1.11 / 2026-09-10 | peer `*` | steer + trigger | detached group, `kill(-pgid)` | no | **Replaces the `bash` tool**, which clashes with gentle-shell's bash rendering and guards. Has monitors. |
| @nklisch/pi-background-tasks | 0.1.8 / 2026-09-08 | no peer | steer + trigger | detached group | no | Poll-until-condition. Small. |
| @vanillagreen/pi-background-tasks | 2.0.2 / 2026-09-21 | peer `*` | steer / followUp | detached, optional tmux | no | Wake budgets and a dashboard; kendex settings layer. |
| pi-background-run, @bytetrue, @tian.zuo, @tylerho, pi-background-bash, … | various | mostly `*` | mostly followUp | various | no | Some override bash or add native deps (koffi, node-pty, effect). |
| @pi-orca/* | 0.0.5 / 2026-05 | — | sendUserMessage | — | **unrelated** | A different "Orca" brand: an inter-session bus. |
| pi-orca-dispatch, @yukikisaku/pi-orca-status | 0.1.0 | — | — | — | Orca tabs/titles | No mailbox. |

No package integrates the Orca mailbox. The good generic ones get the core mechanics right: detached process groups, steer wake, bounded tails. Adopting one would still mean our own Orca layer on top, plus either a bash-tool override or a settings stack we do not control.

### 1.4 Other agents

- **Claude Code**:
  - `run_in_background: true` on Bash, with the `/tasks` list.
  - Auto-backgrounds a command that hits its timeout and reports the task id and output file.
  - The **Monitor** tool streams each output line back as an event. It has a deadline (5 min default, 30 max) and sends one notice when the deadline ends.
  - Background tasks started by the main conversation survive a final response.
  - Source: code.claude.com/docs/en/tools-reference.
- **Codex CLI**: "unified exec" background sessions, a footer row that summarises running processes (`tui/src/bottom_pane/unified_exec_footer.rs`), and `/ps`.
- **OpenCode**: no comparable native wake-on-exit found; not pursued.

Patterns worth copying:
- an explicit background flag;
- the output file path in every notice;
- a deadline on watchers;
- one final notice;
- a compact footer summary.

## 2. Recommendation

Build **`pi-bg`** at `/home/alex/src/pi-bg`: a local git repo, TypeScript, no runtime dependencies, loaded by Pi via jiti.
- It adds tools and does not override `bash`, so it coexists with gentle-shell.
- The Orca bridge is first-class and built on the verified semantics above: a waiter with no type filter plus holding the outstanding delivery means **Orca's typed pointer never fires**.

## 3. Design

### 3.1 Background tasks
- **`bg_run {command, cwd?, label?, timeout_s?, watch?}`**:
  - Spawns `bash -c` in a new process group (`detached`).
  - stdout and stderr go to `~/.local/state/pi-bg/logs/<session>/<id>.log`.
  - Returns at once with the id and log path.
  - A small in-process ring buffer keeps the last output for notices.
- **`watch {pattern, flags?, mode: "until"|"each", max_events?}`**:
  - `until` notifies on the first match; the task ends unless `keep_running`.
  - `each` notifies per match, coalesced over 2 s and capped by `max_events`.
  - Watch tasks default to a 30-minute deadline.
- **Completion notice.** The notice is a custom message of type `pi-bg:task`, sent with `steer` + `triggerTurn`. It contains the id, label, exit code or signal, duration, log path and the last lines, capped at about 2 KB after redaction. Notices from several tasks within 500 ms are batched into one message.
- **Other tools**:
  - `bg_status {id?}` lists tasks.
  - `bg_tail {id, lines?, grep?}` reads a bounded tail from the log.
  - `bg_cancel {id}` sends TERM to the group, then KILL after 3 s.
- **Survival (decided).**
  - On `session_shutdown`, any reason including reload, every task group is terminated: TERM, a short grace, then KILL.
  - A `process.on("exit")` fallback sends synchronous KILLs.
  - A **parent-death watchdog** inside the wrapper script kills the group within about 2 s if Pi is SIGKILLed, so no orphans survive.
  - Logs stay on disk and are pruned after 7 days.
- **Redaction.** Before anything reaches the model or the TUI, the following patterns are redacted: Bearer tokens, `token|secret|password|apikey=…` assignments, `ghp_/gho_/github_pat_`, `sk-…`, AWS keys, JWTs (`eyJ…`) and PEM blocks.

### 3.2 Orca bridge
- **Activation.**
  - Requires `ORCA_TERMINAL_HANDLE` in the environment and `orca` on PATH.
  - At `session_start` the bridge runs `run-current`; if a Run is bound, it arms.
  - It re-detects after bash commands that include `orchestration run-create|run-use`, and polls `run-current` every 2 minutes while no Run is bound.
  - `/orca-watch [run_id|off|status]` overrides detection.
- **Loop.** Exactly one child: `orca orchestration check --wait --timeout-ms 900000 --json`, with **no `--types`**. It runs under the same watchdog wrapper, so it dies with Pi.
  - Timeout → re-arm.
  - Heartbeat-only delivery → re-arm with `--ack <id>` silently. The footer counts heartbeats.
  - Actionable delivery → state becomes `pending(deliveryId)` and a `pi-bg:orca` message is injected (steer + triggerTurn). The waiter is **not** re-armed; the outstanding delivery keeps the pointer suppressed.
- **Delivery message.** Header with the delivery id, Run, counts and replay flag. Then each non-heartbeat message with type, sender, subject, body (≤2000 chars), payload (≤500) and a reply hint. It closes with an explicit instruction: process every message as the orchestration skill requires, then call `orca_ack`. The full raw JSON is saved to `~/.local/state/pi-bg/orca/<delivery>.json`.
- **`orca_ack {deliveryId}`**:
  - Refuses if the id is not the pending delivery.
  - Runs a synchronous `check --ack X --json`. That call acks and returns the next outstanding delivery, if any, so the tool result can carry it inline and set it as the new pending delivery.
  - Otherwise it re-arms the waiter.
- **`orca_inbox`** shows the pending delivery again (useful after compaction) plus the bridge state, read-only.
- **Guard.** While the bridge is active, the bash tool is blocked from running a *consuming* `orca orchestration check` (without `--peek` or `--all`); the block reason points to `orca_ack` / `orca_inbox`. This prevents double consumers and silent double delivery.
- **Errors and backoff.**
  - Unknown or transport errors, including an Orca restart, use exponential backoff from 1 s to 60 s with jitter.
  - `waiter_exists` means another consumer is waiting. The bridge backs off 15 s → 120 s and shows "blocked" in the footer.
  - `consumer_fenced` / `stable_pane_required` stop the bridge, show "fenced", and re-detect with `run-current`.
  - A replay of a delivery that is already pending is ignored.
  - A replay after an ack attempt, or after a reload, is re-injected with a visible **REPLAY** flag, never silently.
- **Footer.** For example `bg 2 · orca ◉ run_8da5 waiting` / `orca ◆ pending d_…` / `orca ⚠ backoff 30s`.

### 3.3 Workers (evaluated, not in v1)
- The same loop works on `dispatch:<id>` via `check --terminal $ORCA_TERMINAL_HANDLE --wait`.
- Benefit: coordinator follow-ups would arrive as steer without the worker polling.
- Risks:
  - the preamble tells workers to run `check` themselves, which is harmless thanks to replay semantics but can duplicate;
  - the dispatch identity changes per Task.
- Proposed as v1.1 behind `/orca-watch worker`, after the coordinator mode is proven.

### 3.4 Testing
- **Unit (node --test, strip types):**
  - CLI output parsing;
  - delivery classification;
  - the state machine (arm / pending / ack / re-arm / backoff / fence / replay);
  - backoff;
  - redaction;
  - the watch matcher and wake budgets;
  - the bash-guard classifier.
- **Manual:**
  - a throwaway Pi session with `pi -e /home/alex/src/pi-bg` in its own Orca terminal;
  - a **test Run** created from that terminal;
  - a trivial Pi worker in a child checkout (status + `worker_done`, no edits).
  - Never touch `run_8da5785a70be`.

## 4. Build and test results (2026-09-26)

- **Repo.** `/home/alex/src/pi-bg` is a local git repo with no remote. Commits: `8886d6c` (feature) and `d9d1b9a` (bg_run guard).
- **Automated tests.** `mise exec -- pnpm test` passes 51/51 and `pnpm typecheck` is clean. The suite covers:
  - unit tests of parsing, deliveries, the state machine, the guard, backoff, redaction and the watcher;
  - real-process tests: exit, watch until/each, deadline, quiet cancel that kills grandchildren, shutdown, and the watchdog on parent death;
  - bridge tests against a fake `orca` CLI.
- **Live lab.** A throwaway Pi (`pi -e`) ran in its own Orca terminal against test Run `run_68df3097271d`. The live coordinator Run was never touched.

| Test | Result |
| --- | --- |
| 1.1 wake when idle | PASS. The notice started a turn with no user prompt. |
| 1.2 watch until READY | PASS. One match notice; the task stopped; no `sleep 600` left. |
| 1.3 `exit 7` | PASS. Reported "FAILED with exit 7" with the last line. |
| 1.5 `/reload` kills tasks | PASS. |
| 1.6 `kill -9` of Pi | PASS. The watchdog removed the task **and the Orca waiter** within 2 s. A fresh Pi re-armed with no `waiter_exists`. |
| 2.1 Run detection after `run-create` | PASS. One waiter, `check --wait --timeout-ms 900000 --json`, with no `--types`. |
| 2.2 status message | PASS. Injected as "Orca delivery", `orca_ack`, re-armed. **No typed pointer.** |
| 2.3 guard | PASS. A consuming `check` in bash was blocked with the explanation (bg_run was later guarded too). |
| 2.4 real Pi worker (status + `worker_done`) | PASS. Deliveries arrived; the coordinator validated, ran `worker-release` and acked. |
| 2.5 message arriving while a delivery is pending | PASS. No pointer after about 60 s idle; the next batch came back inline in the `orca_ack` result. |
| 2.6 `/reload` while pending | PASS. Re-injected with a REPLAY note. |
| heartbeat (sent manually) | PASS. Acked silently via `check --ack <id> --wait`; no model turn. |
| 2.7 second waiter (`waiter_exists`) | PASS. Backoff with "another waiter", then recovered on its own when that waiter ended. |
| 2.8 `/quit` | PASS. No leftover processes. |

**Open items.**

- **Footer visibility.** Gentle Shell shows extension `setStatus` values in its sidebar "Integrations" card and in the narrow bottom bar. The fullscreen header drops them on purpose. In a medium-width fullscreen terminal the pi-bg segment may therefore be invisible. Option: add a one-line widget that appears only while a delivery is pending or the bridge is in backoff or fenced.
- **Worker mode (v1.1).** Not built.
- **Lab side effect.** Pi/gentle ran `git init` in `/tmp/pi-bg-lab`, the known pitfall for non-git directories. The directory was removed.

## 5. v1.1 (fleet watch, worker side, UI) — built, judged, lab-proven (2026-09-26)

- **Judgment Day.** Result: APPROVED after 2 fix rounds (`~/.local/state/financial-hub/tooling/pi-bg-judgment/RESULT.md`). The v1 fixes landed on `main` (`49cfa1f`).
- **Branch.** v1.1 is on `feat/v1.1` in the worktree `/home/alex/src/pi-bg-v11`, head `1582da8`. It passes 98 tests, including an extension harness with a fake ExtensionAPI.
- **Live lab.** Test Run `run_605d929a47ac`. W1 was a Pi worker with pi-bg; W2 was a plain Pi worker. Results:

| Test | Result |
| --- | --- |
| Card | PASS. It showed the bridge, the fleet summary and per-worker rows (`▸ working`, `⏸ done 3m36s`); collapse mode works. |
| W1 `bg_run sleep 120`, then waited idle | PASS. Orca reported W1 `activity: working` while its bg task ran (pi-bg emits `subagent:async-*`), so there was no false stall. The `worker_done` delivery was validated and acked. |
| `orca_watch` settled note | PASS. The note came back verbatim ("LAB-NOTE-OK"). |
| W2 status, then stop without `worker_done` | PASS. "Orca fleet · STALLED … for 3m26s" and FLEET IDLE were delivered; the model reported and did not act (user decision). |
| `/reload` with a stalled worker | One repeated notice, no storm. After this, reported conditions are persisted via appendEntry (`1582da8`), so a reload stays quiet. |
| Cleanup | W2 was released. W1 was retained with reason `external_terminal`, because its terminal was created manually, so it was closed explicitly. No leftover processes. |

**Upstream.** A comment was posted on stablyai/orca#22868 (a generic Pi child-lifecycle event contract).
