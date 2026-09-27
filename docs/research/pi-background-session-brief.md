# Pi background tasks + Orca mailbox: research and our own solution

You are an interactive Pi session in the Financial Hub parent folder (`/home/alex/Projects/financial-hub`, a plain folder of child repos, not a git repo). The user drives this session directly: iterate with them, propose, and ask before installing anything. Reply to the user in Spanish; code, docs and reports in English.

## Problem
The parent orchestrator is a Pi session that coordinates Orca workers (Orca Run `run_8da5785a70be`). Pi's bash tool has no background mode, so the coordinator cannot keep an `orca orchestration check --wait` waiter running while it talks to the user. Without an active waiter, Orca types "You have N orchestration messages. Run `orca orchestration check`" into the coordinator's input box, so it looks like a user prompt. Under Claude Code this was solved with a background Bash waiter.

More generally we want background work in Pi that notifies or wakes the model when it finishes, without polluting the user input. Examples:
- the Orca mailbox waiter;
- long gates (`pnpm run verify`, integration suites);
- `gh run watch` / `gh pr checks --watch` for CI;
- deploy/ansible runs;
- production log tails and watchers ("tell me when the 04:00 reconcile finishes");
- any long command.

## What is already known (verify, do not trust blindly)
Previous quick research, Engram topics `orca/pi-mailbox-delivery` and `orca/pi-mailbox-delivery-research`:

**Orca** (github.com/stablyai/orca; local app 1.4.212, CLI `orca`):
- There is no setting to disable the pointer. It is typed by `formatMessagePointer` from the pending-message delivery path when the coordinator pane is idle and no waiter is active.
- Related issues:
  - #16822: the pointer conflicts with push coordination; the reporter asks for a switch;
  - #19541: quiet mode for the inbox nudge;
  - #14897: runtime nudge of silent dispatches.
- Draft PR #15451 "supervise fresh Pi workers over RPC" (2026-08-19, stale) is about workers, not the coordinator inbox.
- Docs: `orca skills get orchestration` and `--reference references/messaging-and-gates.md`.
- Mailbox semantics:
  - A delivery replays the whole oldest FIFO batch until `--ack`.
  - Only one `--wait` waiter is allowed per Run (`waiter_exists`).
  - An active waiter suppresses the pointer.
- Existing Orca-managed Pi extensions live in `~/.pi/agent/extensions/`: `orca-agent-status.ts`, `orca-prefill.ts`, `orca-titlebar-spinner.ts`. Env: `ORCA_*`, `ORCA_TERMINAL_HANDLE`, `ORCA_AGENT_HOOK_*`.
- Helper `~/.local/bin/orca-wait` (Python) waits and auto-acks heartbeat-only batches.

**npm Pi packages:**
- `pi-background-tasks` 2.6.7: `bg_run` completion can wake a follow-up model turn. But its peerDeps cap pi-coding-agent at ^0.84, and we run Pi 0.87.1.
- `pi-better-background-tasks` 0.2.17: background tasks and watchers with completion notifications, tmux-backed; peer `*`.
- `pi-mesh-extension`, `pi-mail`, `@arcanemachine/inter-agent-pi`: separate agent buses, not Orca.

**Already installed:**
- gentle-shell (`/home/alex/src/gentle-shell`, extension `extensions/gentle-agents.ts`): background subagents deliver results with `pi.sendMessage(..., { deliverAs: "steer", triggerTurn: true })`, and `orchestrator_send_message` sends notifications between peer Pi sessions (`deliverAs: "followUp"`). Read that code: it shows the Pi extension API for injecting non-user messages.
- Installed packages are listed in `~/.pi/agent/settings.json` under `packages`. The Pi SDK is under `~/.pi/agent/npm/node_modules` and in Pi's install.

## Goal
1. **Survey:**
   - What exists: Pi packages, Pi SDK/extension API capabilities (`sendMessage` delivery modes, `triggerTurn`, events, UI widgets/footer, custom message renderers), Orca's docs/CLI/issues/PRs, and relevant patterns from other agents (Claude Code background Bash and Monitor, Codex, OpenCode).
   - Install nothing yet. Read packages by unpacking them (`npm pack`) into `/tmp`.
   - Report compatibility with Pi 0.87.1, maintenance, security (anything that spawns shells or phones home), and fit.
2. **Design our own solution.** Unless the survey finds something clearly better, design a small Pi extension package we own, e.g. `pi-orca-bridge` or `pi-bg`. Requirements:
   - **Background command tool:** the model starts a command in the background and immediately keeps working or talking. Output goes to a log file. On exit it injects a compact, clearly non-user message (custom type and renderer) and wakes a turn if idle, or queues as steer if busy. It needs status/tail/cancel tools, bounded output, and survival rules (what happens on `/reload` and exit). Optional "watch until regex/condition" mode with timeout.
   - **Orca mailbox bridge:**
     - When the session is an Orca coordinator bound to a Run, keep exactly one `check --wait` waiter alive. Detect the Run from the terminal handle and `orca orchestration run-list`, or configure it explicitly with a `/orca-watch <run>` command.
     - Inject each delivery as a rendered "Orca" message with deliveryId, types, subjects and bodies. Heartbeat-only batches are auto-acked silently.
     - Actionable batches are not acked automatically; the model acks after processing, via a tool or the CLI. Then re-arm the waiter.
     - Handle `waiter_exists`, `consumer_fenced`, Orca restarts and CLI errors with backoff. Never double-deliver silently.
     - This must stop Orca's typed pointer, because a waiter is active.
   - Workers too: consider the same bridge for dispatched Pi workers, whose coordinator follow-ups arrive via `check --terminal <handle>`. Evaluate; do not necessarily build it.
   - Clear, low-noise UI: footer segment for running tasks and the waiter state.
   - No credentials in logs or messages; bounded memory and output.
3. **Build it:**
   - Create a new local git repo at `/home/alex/src/pi-orca-bridge`, or a better name agreed with the user. No remote unless the user asks.
   - TypeScript, following gentle-shell's extension conventions. Include tests for the pure logic (delivery parsing, ack/re-arm state machine, backoff) and a manual test plan.
   - Toolchain: mise, if the repo needs Node tooling.
4. **Test safely:**
   - Load it in a *separate throwaway Pi session* first (`pi -e <path>` or equivalent), in its own Orca terminal.
   - For the Orca bridge, create a *test Run* from that test terminal and a trivial throwaway worker (e.g. a Pi worker in a child checkout told to only send one status and a `worker_done`, with no edits).
   - **Never run `check`, `--ack` or `--wait` against Run `run_8da5785a70be`.** It belongs to the live coordinator; consuming its mailbox would steal the orchestrator's messages.
   - Never `run-create` from the coordinator's terminal.
5. **Install only with the user's go:**
   - Add it to `~/.pi/agent/settings.json` `packages`.
   - Tell the user which sessions must restart. The coordinator will then restart itself and switch.
   - Update the parent `AGENTS.md` Orca guide (coordinator "Never wait blind" and pitfalls) with the new mechanism. Only after it is proven.

## Output
- **Research report:** `/home/alex/.local/state/financial-hub/tooling/pi-background-research.md`. It covers what exists, a comparison table, the recommendation and design.
- **Code:** the new repo under `/home/alex/src/`.
- **Engram** (project `financial-hub`): save the survey result and design decisions (`topic_key` `tooling/pi-background-orca-bridge`).
- When ready to install, or if you find something the orchestrator should know, notify it. The Morningstar session does the same. Use:

  ```
  orca orchestration send --to run:run_8da5785a70be --type status --subject "pi-bg-bridge: <topic>" --body "<3-5 lines + report path>"
  ```

  Sending is fine; consuming that Run's mailbox is not.

## Rules
- No writes in the child repositories or the parent folder, apart from the `AGENTS.md` update after approval.
- Do not modify installed third-party packages or the Orca app. Orca issues and PRs are read-only; any public comment needs the user's explicit OK.
- Do not run gentle-ai review / RDD.
- Never print credentials.
- Pi 0.87.1, Orca 1.4.212 on Linux (CachyOS), fish shell for the user; the bash tool runs bash.

## Start
Read this brief, then give the user a short Spanish summary: what you will check, the design sketch, and open questions (name, scope v1). Wait for their go before building.
