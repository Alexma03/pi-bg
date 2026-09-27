# Orca 1.4.212: supervised workers that are not Pi (claude, codex, cursor, opencode...)

Read-only research, 2026-09-27. No Orca state was mutated; no tokens or `endpoint.env` contents were read.

## 0. Evidence base and one version caveat

- Install: Orca is an **AppImage**. `which orca` -> `~/.config/orca/linux-orca-cli-shim/orca` -> `~/.cache/orca/appimage/launcher/orca-ide` -> `.../c52eb721cc0f1d53f40a8114/resources/bin/orca-ide`. The running instance is mounted at `/tmp/.mount_Orca.AbgDOOF/resources/app.asar`.
- `package.json` inside that asar reports **`"version": "1.4.212"`** — the build analysed. `orca --version` prints `1.4.215`, and `orca skills get ...` is served by the newer bundled CLI (`resources/bin/orca-ide`, mtime later than the asar). *Runtime* semantics below are 1.4.212; *skill prose* below is 1.4.215. Where they disagree I say so.
- Extraction: `npx --yes @electron/asar extract /tmp/.mount_Orca.AbgDOOF/resources/app.asar /tmp/orca-asar-research/app`. Layout: minified main bundle `out/main/index.js` (8.1 MB, symbols renamed to 2-3 chars), **readable CJS modules in `out/shared/**` (1238 files)**, CLI in `out/cli/**`. Almost all orchestration logic is only in the minified `index.js`; citations name the minified symbol plus the readable module that documents it.
- Installed hook state: `~/.claude/settings.json` (hooks), `~/.codex/hooks.json`, `~/.orca/agent-hooks/{claude,codex,cursor,antigravity,command-code}-hook.sh`, `~/.config/orca/agent-hooks/{endpoint.env,last-status.json,spool/}`, `~/.config/orca/{omp-managed-status-extension,opencode-hooks,opencode2-hooks,codex-real-home-hooks}`.

---

## 1. How a coordinator message reaches a running non-Pi worker

### 1.1 Two independent halves

`orca orchestration send --to dispatch:<id>` is **two effects**:

1. **Durable enqueue** in `~/.config/orca/orchestration.db` (`messages` row, `to_handle = 'dispatch:<id>'`). This is the authority, and it is unconditional.
2. **Best-effort attention**: Orca may *type a line into the worker's PTY*.

The bundled skill states this contract explicitly:

> "A successful `orchestration send` proves durable enqueue; its wake or nudge is best-effort attention only and does not prove the recipient read or accepted it." — `orca skills get orchestration` (Authority and safety floor)

> "A successful `send` proves durable enqueue. Wake and nudge are best-effort attention only: neither proves the recipient read the message, began a turn, or accepted steering." — `references/messaging-and-gates.md`

> "The coordinator steers a running worker with `send --to dispatch:<id>`. **That enqueue is durable but does not interrupt you, so nothing arrives unless you look.**" — `references/worker-contract.md`

### 1.2 The only thing Orca ever types into a non-Pi worker

Minified `out/main/index.js`, function `cKn`:

```js
function cKn(e, t, n = `orca`) {
  return `\nYou have ${e} orchestration ${e === 1 ? `message` : `messages`}. Run \`${n} orchestration check${t?.startsWith(`run:`) ? ` --run ${t.slice(4)}` : ``}\`.\n`
}
```

- The **count only**. No subject, no body, no sender, no IDs. `n` is `getTerminalOrchestrationCliCommand(handle)`, so it prints the worker's own Orca CLI path.
- Written by `writeOrchestrationPointerPty` -> `ptyController.writeWithSettlement(ptyId, data)` (`out/main/index.js`, class `fQa`). It is a **raw PTY write**, i.e. keystrokes into the TUI composer — *not* the argv `--prefill` path used to deliver the dispatch preamble (`shared/tui-agent-config.js`: claude `promptInjectionMode: 'argv'`, `draftPromptFlag: '--prefill'`).
- Batched up to 50 rows; types already reserved by a live `check --wait` waiter are excluded (`Iua`, `Fua`, `Lua` in `index.js`).

### 1.3 Then Orca presses Enter — 500 ms later

`Xpa` -> `Zpa` (both in `index.js`):

- `Zpa` stages the pointer enter in the DB (`stageMailboxPointerEnter`, `markMailboxPointerWriteAttempted`), sets a watermark, writes the text, then arms `enterTimer = setTimeout(..., enterDelayMs)`. `Qpa = 500` ms default, overridable only by the E2E env var `ORCA_E2E_ORCHESTRATION_POINTER_ENTER_DELAY_MS`.
- The Enter is `Ypa`, which writes a literal `"\r"` to the PTY. Before pressing it `Ypa` re-reads the live leaf and presses Enter only if `lastAgentStatusObservedLive && (lastAgentStatus === 'idle' || lastAgentStatus === 'working')`.
- If the agent went `working` inside that 500 ms window, **Enter is still sent** into a busy composer. If the operator had half-typed something, Orca's Enter can submit it.

### 1.4 The gate: delivery is idle-only

`orchestrationMailboxPointerDelivery` (class `ema` in `index.js`):

```js
deliverForHandle(e, t) {
  let n = this.deps.deliveryTarget.resolveTerminalHandle(e);
  if (n) try {
    let r = this.deps.getLiveLeafForHandle(n);
    if (r.lastAgentStatus !== `idle` || !r.lastAgentStatusObservedLive) return;   // <- hard gate
    let i = this.deps.mailboxOwner.resolve(r, e);
    i && this.deliver(r, { mailboxHandle: i, reservedTypes: t })
  } catch {}
}
```

Corroborating behaviour in the same class:

- `observeAgentWorking(ptyId)` — on a transition to `working`/`permission`, any in-flight delivery is *deferred* and the pending pointer is released (`releasePendingMailboxPointerForPty`). Nothing is typed.
- `observeAgentIdle(ptyId)` — on a transition to `idle`, `deliverPendingMessagesForLeaf` runs.
- `markPtyColdParked` / `deferFlightUntilIdle` — an explicit "wait until idle" park.

**Answer:** Orca never interrupts a busy non-Pi worker. It enqueues durably, and types "You have N orchestration messages. Run `orca orchestration check`." + Enter **the next time the worker's agent is observably idle**, then retries on every later idle transition.

### 1.5 Provider-specific differences: none, in the delivery path

`deliverForHandle` branches on nothing agent-specific. The only per-agent divergence in the whole delivery path is which *idle* signal happens to fire:

| Worker | Idle evidence Orca uses |
| --- | --- |
| `claude` | Claude Code's own terminal title (spinner vs `CLAUDE_IDLE`) via `shared/agent-title-status.js` -> `computeAgentStatusFromTitle`, plus the `Stop` hook. |
| `codex` | Codex does not set a distinguishing idle title; Orca has a special case `agent === 'codex' ? 'idle' : undefined` when restoring after exit, and leans on the `Stop` hook + `shared/agent-hook-listener/providers/codex-events.js`. |
| `cursor`, `opencode`, `opencode2`, `gemini`, `droid`, `grok`, `antigravity` | Same title/hook path, same idle gate. `opencode` has an explicit `isOpenCodeNativeTitle` branch in `computeAgentStatusFromTitle`. |
| `pi` / `omp` / `prime-agent` | Identical machinery, *plus* Orca's managed extension, a first-class citizen here (see 2.3). |

So the *mechanism* is provider-blind. The *probability of a timely nudge* is not: a worker whose agent emits neither an idle title nor a `done` status row is never nudged at all, and the message sits in the DB until a human or the agent's own read of its inbox observes it.

### 1.6 Interrupting a busy worker is a different, explicit command

`orca terminal send --terminal <handle> --interrupt` exists and is separate from orchestration (`orca terminal send --help`: "--interrupt  Send as an interrupt-style input when supported"). Escape/Ctrl-C intent classification lives in `out/shared/agent-interrupt-intent.js`: `ESCAPE_ALSO_NAVIGATES_AGENT_TYPES = {claude, omp, pi, prime-agent}` (one Escape may just close an overlay) and `DOUBLE_ESCAPE_INTERRUPT_AGENT_TYPES = {opencode, opencode2, copilot}` (needs two). Codex is in neither set, so a single Escape counts as an interrupt there. A coordinator that wants to interrupt a busy worker must resolve the agent terminal handle from `worker-show` and use `terminal send` — orchestration itself never does this.

### 1.7 Structured (non-terminal) workers — a different lane, not claude/codex

`orchestrationStructuredMailboxPointerDelivery` (class `Rua`) serves handles prefixed `structworker_` (`aj()` in `index.js`) and Orca's native agent-session host. It injects the same `cKn` text but as a **`role: 'user'` message inside the session journal**, gated by `Twn(readGateFacts(session))`:

```js
function Twn(e) {
  return e.session
    ? e.session.awaitingHuman ? { deliver: !1, retain: `awaiting-human` }
    : e.session.turnRunning  ? { deliver: !1, retain: `turn-unsettled` }
    : { deliver: !0 }
    : { deliver: !1, retain: `session-not-attached` }
}
```

Same idle rule, structured transport. A claude/codex TUI worker is *not* on this lane.

---

## 2. How Orca decides working / idle / done / blocked

### 2.1 Three vocabularies, do not mix them

| Vocabulary | Values | Source |
| --- | --- | --- |
| `agent_status.state` (hooks / OSC 9999) | `working`, `blocked`, `waiting`, `done` | `out/shared/agent-status-types.js`: `AGENT_STATUS_STATES` |
| pty `lastAgentStatus` (the delivery gate) | `working`, `permission`, `idle`, `null` | derived, see below |
| fleet `projection.attention.categories` | `guidance`, `input`, `approval`, `failure`, `interruption`, `stale`, `unverifiable`, `root_completion` | `out/shared/orchestration-fleet-attention.js` |

Mapping between (1) and (2) is `Sua` in `index.js`: `blocked|waiting -> 'permission'`, `working -> 'working'`, `done -> 'idle'`.

### 2.2 Which providers get `stage.activity` and liveness `agent_status`

`stage.activity` in the fleet projection (`GSn` in `index.js`):

```js
stage: { worker: e.workerState, dispatch: e.dispatchStatus, detail: e.workerStage,
         activity: i && a ? a.state : `unknown` }
```

where `i = liveness.verdict === 'live'` and `a` is the matched agent-status row. So **`stage.activity` is exactly the `agent_status.state` of the freshest hook/OSC row bound to that pane** — the CLI reads it at `out/cli/handlers/orchestration/worker-terminal-handlers.js:78`: `const stage = projection?.stage.activity ?? worker.dispatchStatus;`.

Liveness (`VSn` in `index.js`) is layered, and the only `live` source is the hook/OSC row:

| verdict | reason | condition |
| --- | --- | --- |
| `exited` | `worker_stop` / `process_exited` / `operator_close` / `signaled` / `resource_release` | proven death |
| `unverifiable` | `missing_status` | no row at all (or `providerSessionOnly`) |
| `unverifiable` | `stale_status` | newest row older than **`18e5` ms = 30 min** (`Jne = 1800*1e3` in `index.js`; same value as `AGENT_STATUS_STALE_AFTER_MS` in `out/shared/agent-status-freshness.js`) |
| `unverifiable` | `restored_unconfirmed` | row was rehydrated, not observed |
| `unverifiable` | `future_status` | row clock more than `RSn = 5e3` ms ahead |
| `live` | `agent_status` | a fresh, confirmed row |

**Which providers get rows:**

1. **Managed HTTP hook scripts** — `out/shared/agent-hook-types.js`: `AGENT_HOOK_TARGETS = ['claude','openclaude','codex','gemini','antigravity','amp','cursor','droid','command-code','grok','copilot','hermes','devin','kimi','muse','zcode']`. Verified installed here: `~/.claude/settings.json` carries an Orca entry on **15** Claude Code hook events (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `TeammateIdle`, `PostCompact`, `SessionEnd`); `~/.codex/hooks.json` carries Orca on 8 (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`, `SubagentStart`, `SubagentStop`), all pointing at `~/.orca/agent-hooks/codex-hook.sh`.
2. **Pi-family / OMP / opencode plugins** (not in `AGENT_HOOK_TARGETS`, but they do post to the same listener): `~/.config/orca/omp-managed-status-extension/orca-agent-status.ts` posts to `/hook/omp`; `~/.config/orca/opencode-hooks/shared/plugins/orca-opencode-status.js` posts to `http://127.0.0.1:<port>/hook/opencode`.
3. **OSC 9999 frames** — `out/shared/agent-status-osc.js`, prefix `\x1b]9999;`, payload `JSON.parse`d through the same `normalizeAgentStatusPayload` validator, state restricted to `['working','blocked','waiting','done']` (`Zne` in `index.js`). Handled in the main process on every PTY chunk (`processAgentStatusOscForPty` -> `nwa()`), and each frame sets `pty.lastExplicitAgentStatus = { state, updatedAt }` and fires `recordAgentPromptLifecycleState`. `AGENT_STATUS_OBSERVATION_ORIGINS` (`out/shared/agent-status-observation.js`) lists the ingress ranks: `hook`, `osc`, `title`, `process`, `launch`, `orchestration`, `structured`.
4. **Terminal title** — `out/shared/agent-title-status.js` `computeAgentStatusFromTitle`, the weakest evidence but the one that actually drives `lastAgentStatus`, hence delivery.

Observed live example (`~/.config/orca/agent-hooks/last-status.json`, field names only, no values that are secret): an entry keyed `<paneKey>:<paneKey>` with `source: "cursor"`, `hookEventName: "postToolUse"`, `payload: {state, prompt, agentType, toolName, lastAssistantMessage, lastAssistantMessageIsToolOutput}`, `receivedAt`, `stateStartedAt`, `launchTokenHash`. The `spool/pane-<uuid>.jsonl` files are the crash-safe fallback the hook scripts append to when the listener is down.

### 2.3 The idle decision, exactly

`isTuiIdleSatisfiedForLeaf` / `isTuiIdleSatisfiedForPty` -> `m6({record, rendererTitle, readPositiveBodyEvidence, readMuseReadyBodyEvidence, agent, firstPartyStatus, quiescenceMs})`:

```js
function m6(e) {
  return vfa(e.record, e.rendererTitle) || e.readPositiveBodyEvidence() ? !0
       : yfa(e.firstPartyStatus) ? !1
       : Cfa(e.record, e.agent, e.readMuseReadyBodyEvidence, e.quiescenceMs) ? !0
       : xfa(e.record, e.agent, e.quiescenceMs)
}
```

- `vfa` — title (pane title or `lastOscTitle`) normalizes to `idle`.
- `readPositiveBodyEvidence` — the adopted PTY's explicit idle status is `idle`, **or** the tail buffer's last cursor/prompt marker is positive (`$3(f6(tailBuffer, tailPartialLine, preview))`).
- `yfa(firstPartyStatus)` = `Xne(state, now, 1800*1e3)` = *fresh and not `done` => return `false`*. **First-party status is a veto only.** A hook/OSC row saying `working` blocks idle; a row saying `done` merely stops vetoing and lets the title/quiescence path decide.
- `xfa` — `lastAgentStatus === 'idle'` **and** 3 s of output quiescence (`g6 = 3e3`).
- `armDeliveryRecheck` re-arms a timer at `max(3000 - msSinceLastOutput, 0) + 50` so delivery is retried automatically once output stops.

**Practical consequence for non-Pi workers:** if the agent sets no idle-bearing title, Orca never gets `lastAgentStatus === 'idle'` and the coordinator's mail is never typed — even though it is durably stored. Coordinator tooling must therefore poll the DB, not the terminal.

---

## 3. A non-Pi worker that ends its turn without `worker_done`

**Orca does not remind it, does not nudge it, and does not retry.** Findings:

- The dispatch preamble is injected **once**, at `worker-start` / `dispatch --inject` (`PN` in `index.js`), and is the only place the obligation is stated.
- The only automated reminder machinery in the bundle is a *request-dedupe* marker, `var AP = '__orcaReplayNudge'` with `EGn`/`MP` helpers in `index.js` — CLI replay fingerprints, **not** a worker nudge. The word "nudge" in `index.js` outside the skill guide is auto-updater code (`checkForUpdateNudge`, `nudgeCheckTimer`).
- `attempt_observation_facts` — the durable evidence rows the fleet reads — are written **only** from an accepted `worker_done` (`LRn` in `index.js` writes facet `worker_report`, status `accepted`). No turn-end detector feeds it.
- Coordinator->worker control mail explicitly refuses to carry lifecycle: `"Coordinator-to-worker control mail cannot report worker lifecycle."`, and `GGn` returns `{action:'ignored'}` for `status|dispatch|merge_ready|escalation|handoff|decision_gate|question`.

What Orca *does* instead is **mark the Dispatch, for the coordinator** (`getWorkerAttentionFacts`, `NSn`/`GSn` in `index.js`):

| SQL fact (`GSn` input) | attention category |
| --- | --- |
| unread, undelivered row in `dispatch:<id>` | `guidance` |
| pending `question_threads` row | `input` |
| pending `decision_gates` row | `approval` |
| outcome `failed` | `failure` |
| `workerState === 'abandoned'` or `termination_reason in {operator_close, signaled}` | `interruption` |
| liveness `unverifiable` with reason `stale_status` | `stale` |
| liveness `unverifiable`, any other reason | `unverifiable` |

**The `nextAction` ladder never contains a `send`** (`USn` in `index.js`) — only `worker-release`, `worker-read`, or `worker-show`:

```js
t.verdict === `exited`  && !settled && !pendingInput && !pendingApproval
  ? { kind:`recover`, argv:['orchestration','worker-read','--dispatch',id] }
: (t.verdict === `live` && e.workerState === `ready` && !pendingInput && !pendingApproval)
  || (t.verdict === `unverifiable` && !pendingInput && !pendingApproval)
  ? { kind:`none`, argv:[] }
: { kind:`inspect`, argv:['orchestration','worker-show','--dispatch',id] }
```

Settlement ladder: `resolveFleetWorkerOutcome` (`out/shared/orchestration-fleet-outcome-resolution.js`) returns `in_progress` while `dispatchStatus in {pending, dispatched}`; a worker that idles forever with no `worker_done` **stays `in_progress` and `live` forever**. Only an accepted `worker_done` (or `worker-stop` / `worker-abandon`) moves it.

The skill is explicit that this is a human/coordinator decision, not an automated one:

> "After three consecutive empty waits, stop waiting blindly and enumerate with `ORCA orchestration worker-list --include-remote --json` ... Leave the wait only on positive proof the agent stopped: `exited` liveness, the worker's own observation of process exit, or a transcript whose final agent turn sent no `worker_done`." — `orca skills get orchestration`

> "Leave the wait only on positive proof the agent stopped ... `unverifiable` is absence ... Absence never authorizes stop, abandon, retry, or release; keep waiting, or inspect." — `references/recovery-and-cleanup.md`

**"Retry/continue" mechanisms that do exist**, all coordinator-initiated and explicit: `worker-start --task <id> --retry-of <dispatch_id>` (only after a *proven* failed/stopped attempt; three failures circuit-break the Task), and `worker-start --task <next> --terminal <agent_handle>` for same-terminal reuse. Neither is automatic, and neither "continues" the old attempt.

**Answer:** nothing automatic. Orca records the absence, ages the status row into `stale` after 30 minutes, and hands the decision to the coordinator.

---

## 4. `worker-read --source transcript` per agent

Gate function in `out/main/index.js`:

```js
function Yj(e) {                      // agent id -> transcript dialect, or null
  return e === `claude` || e === `openclaude` ? `claude`
       : e === `codex`   || e === `grok` || e === `omp` ? e
       : null
}
async function ajn(e) {
  if (!Yj(e.agent)) return { ok: !1, reason: `provider_unsupported`, warnings: [] }
  let t = DM(e.agent)
  if (!t)            return { ok: !1, reason: `provider_unsupported`, warnings: [] }
  ...
}
function DM(e) { let t = Yj(e); return t === `claude` ? rEn : t === `codex` ? sEn : t === `grok` ? vEn : t === `omp` ? OEn : null }
```

| agent id | `--source transcript` | reader |
| --- | --- | --- |
| `claude`, `openclaude` | yes | `rEn` — Claude Code `~/.claude/projects/**/*.jsonl` (`type: user\|assistant`, content blocks) |
| `codex` | yes | `sEn` — Codex rollout JSONL (`response_item` / `event_msg`) |
| `grok` | yes | `vEn` — Grok session JSONL |
| `omp` | yes | `OEn` — Pi/OMP-shaped session JSONL (`message` / `custom_message`, roles `toolResult`, `bashExecution`, `pythonExecution`, `fileMention`) |
| **`pi`** | **no — `provider_unsupported`** | — |
| `prime-agent`, `cursor`, `opencode`, `opencode2`, `gemini`, `droid`, anything else | no — `provider_unsupported` | — |

Fallback reasons are enumerated in `out/shared/orchestration-worker-output.js`: `ORCHESTRATION_WORKER_READ_FALLBACK_REASONS = ['provider_unsupported','session_not_reported','transcript_empty','transcript_missing','transcript_unreadable','transcript_parse_failed','remote_capability_unavailable']`; sources are `['auto','transcript','terminal']`.

**Answer: yes, `claude` and `codex` both support `--source transcript`, and plain `pi` does not** — but the real reason is not "Pi is unsupported" in general: `omp` (Orca's managed Pi) *is* supported with a Pi-dialect reader (`OEn`), and the allowlist simply never learned the bare `pi` id. `shared/pi-agent-kind.js` `isPiCompatibleAgentType` confirms `pi` is a first-class agent type elsewhere, so this is an allowlist gap, not a format gap.

Note a documentation divergence: `orca orchestration worker-start --help` says "Read output with `worker-read --source auto` or `--source transcript`, which always work". The *commands* always work; the transcript *source* is refused with `provider_unsupported` for the ids above. Trust the `fallbackReason` in the JSON, not that sentence.

`--source auto` is the safe default: it uses a proven provider transcript when available and otherwise returns bounded terminal output with a typed `fallbackReason` (`references/recovery-and-cleanup.md`). Cursors are pinned to the exact source; a `source_changed` result means restart without the old cursor.

---

## 5. Heartbeats

**Every heartbeat is sent by the agent itself, by hand, per the injected preamble. Orca sends none automatically.**

- The cadence is a compile-time constant in the preamble builder: `var wFn = 5` next to `PN` in `out/main/index.js`, rendered as `# Send a heartbeat every ${wFn} minutes`.
- The instruction block from `PN`:

```
# Send a heartbeat every 5 minutes
# while actively working on the task. The coordinator uses this to
# distinguish "still thinking" from "hung / crashed." Skip heartbeats only
# while blocked inside `check --wait` or `ask` - those calls are
# themselves liveness signals.
#
# Include BOTH taskId and dispatchId in the payload: the coordinator
# attributes the heartbeat to the specific dispatch context, not just
# the task, so a straggler heartbeat from a previously-failed dispatch
# cannot mask a hung retry.
${cli} orchestration send --from <handle> --dispatch-capability <cap> --type heartbeat \
  --subject "alive" --task-id <id> --dispatch-id <id> --phase "<short: investigating|implementing|reviewing|waiting>"
```

- Inbound handling is `KGn` in `index.js`: it resolves the caller's Dispatch, refuses `sender_not_assignee`, and calls `recordHeartbeat` (a `last_heartbeat_at` write). That is the *only* caller of `recordHeartbeat` in the bundle.
- The `heartbeat` / `heartbeatConnections` / `heartbeatIntervalMs` symbols elsewhere in `index.js` are **WebSocket transport** keepalives (`k4a = 15e3` ms ping), unrelated to orchestration.
- `references/worker-contract.md`: "Send heartbeats only at the cadence required by the live preamble ... A heartbeat proves liveness, never completion."
- Heartbeats are *lifecycle mail from the worker*, so `JN` in `index.js` refuses them as group targets: `` `${e} messages belong to one exact Dispatch and cannot target a group address.` ``

**Per provider this is identical, and that is the whole problem.** A claude or codex worker follows the preamble only if it happens to read and obey it. The preamble also says so out loud ("Read coordinator follow-ups. **Nothing interrupts you**: a durable message only arrives when you look"). A coordinator watching a non-Pi worker is watching *compliance*, not *mechanism*.

Related: the preamble's completion block (`TFn`) has a `bare-shell` variant ("Exit the shell after completion. Bare-shell workers have no idle agent prompt for Orca to reuse") and a `prompt-returning-agent` variant. In 1.4.212 `workerKind` is **never set** by any caller, so `e.workerKind ?? 'prompt-returning-agent'` always takes the second branch — the bare-shell branch is dead code in this build.

---

## Implications for pi-bg

**What pi-bg can do (all within documented contracts):**

1. **Be the coordinator-side nudger Orca is not.** Orca's only worker-directed action is one idle-gated line of text. pi-bg can poll `orca orchestration worker-list --json` and, for a row whose `stage.activity` is `done` (or whose `projection.liveness.reason` is `stale_status`) while `projection.outcome` is still `in_progress`, issue `orca orchestration send --to dispatch:<id> --subject "..." --body "..."` as a human-intent reminder. It will land in the mailbox and, for an idle worker, be typed within ~500 ms + 3 s quiescence. Budget for the case where the agent sets no idle-bearing title: then it is never typed, and the only remaining lever is `orca terminal send --terminal <handle> --text ... --enter`.
2. **Detect "turn ended without `worker_done`" without Orca's transcript layer.** For claude and codex, `worker-read --source transcript --limit N` gives a structured, cursor-paginated tail; a final assistant turn with no orchestration-send record in it is the exact positive proof `references/recovery-and-cleanup.md` asks for. For `pi` workers this is exactly the gap pi-bg can fill — see (3).
3. **Emulate `omp` for `worker-read --source transcript`.** `OEn` in `index.js` already parses the Pi/OMP session JSONL shape (`type: message|custom_message`, `message.role in {toolResult, bashExecution, pythonExecution, fileMention}`). If pi-bg writes that same shape, Orca's transcript reader would work for `pi` too — except the `Yj` allowlist rejects the id first. That is an upstream one-line allowlist change, not a format change.
4. **Own `agent_status` for Pi deterministically.** Orca's delivery gate is `lastAgentStatus === 'idle'`, and the strongest lever on it is the terminal title (`shared/agent-title-status.js` `computeAgentStatusFromTitle` understands the `pi - ` marker, `getPiStateTitleStatus`, and braille spinner frames). Independently, an OSC 9999 frame (`\x1b]9999;{"state":"working"|"done"}\a`) sets `lastExplicitAgentStatus`, which can *veto* idle while fresh but cannot by itself grant it. pi-bg emitting the right title marker is the cheapest way to make Orca's nudges land on Pi workers at the same moment they land on claude.
5. **Use the group addresses for fan-out.** `@all`, `@idle`, `@claude`, `@codex`, `@opencode`, `@gemini`, `@droid`, `@grok`, `@cursor`, `@worktree:<id>` (all scoped to the sender's own Run) reach only live Dispatches — a legitimate one-shot "status check, everyone" nudge. Lifecycle types (`worker_done`, `heartbeat`) are refused as group targets.
6. **Read `projection.nextAction` and obey it literally.** It is only ever `worker-release` / `worker-read` / `worker-show` / `none`. It is a read-and-inspect recommendation, not a cleanup command, and it never asks you to stop anything on its own.

**What is impossible from outside Orca:**

- **Interrupting a busy worker through orchestration.** There is no orchestration interrupt. The only primitive is `orca terminal send --terminal <handle> --interrupt` (ESC/Ctrl-C intent, with per-agent quirks in `shared/agent-interrupt-intent.js`), and you must resolve the agent terminal handle from `worker-show` yourself. Nothing in the mail path will ever cut a turn short.
- **Making Orca auto-settle, auto-retry, or auto-continue a silent worker.** `nextAction` never contains a `send`; `attempt_observation_facts` are written only by an accepted `worker_done`; retry requires a *proven* failed/stopped attempt plus a human `worker-start --retry-of`. Absence never authorizes anything, by explicit design.
- **Getting the message body into the terminal.** `cKn` writes only a count and the literal `Run \`orca orchestration check\``. If you need prose in the composer's context, you must use `orca terminal send` yourself — and that bypasses the idle gate, so you own the risk of typing into a busy or half-typed composer.
- **Getting `provider_unsupported` transcripts for `pi`, `cursor`, `opencode`, `gemini`, `prime-agent`, `droid`.** That is a hard-coded allowlist (`Yj`) plus a dialect map (`DM`). The only available signal for those agents is `--source terminal` (bounded tail), or Orca's own `stage.activity` / `liveness` projection, which is `unknown` / `unverifiable` when the agent emits no hook row.
- **Trusting `stage.activity` as proof of liveness.** It is `unknown` unless a *fresh* (<=30 min) confirmed agent-status row is bound to the pane, and it is the hook row's state, not Orca's verdict. `projection.liveness.verdict` is the authority; `worker-show`'s `observation.status` is PTY-only and "a live terminal can still hold a dead or stuck agent".
- **Depending on `workerKind: bare-shell` semantics.** Dead code in 1.4.212. If pi-bg launches a plain shell as a supervised worker, it will be given the `prompt-returning-agent` completion contract and Orca will expect an idle prompt to re-engage.

**Version caution.** The runtime analysed is 1.4.212; `orca` and `orca skills get` are 1.4.215. The 30-minute liveness/staleness constant, the `cKn` pointer text, the 500 ms enter delay, the 3 s quiescence, `AGENT_HOOK_TARGETS`, and the `Yj`/`DM` transcript allowlist were all read from the 1.4.212 asar. Re-verify them against a fresh extraction before relying on the exact numbers.
