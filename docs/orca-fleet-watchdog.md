# Orca fleet watchdog and coordinator workflow proposal

## Decision
Keep supervision in pi-bg's existing coordinator extension. A poll must be read-only, local and cheap; the watchdog makes no model calls and never nudges, releases, closes, or edits a worker. It coalesces only new findings into a wake notice, and persists its detector state under the configured pi-bg state directory.

## Watchdog behavior

- **Cadence:** every 2 minutes by default. The read-only worker inventory still refreshes on the existing 30-second fleet cadence; terminal snapshots and Git scope checks are bounded to the watchdog cadence.
- **Scope:** for each local open worker with a Task `Allowed edit surfaces` section, compare committed changes since `merge-base origin/main` plus staged, unstaged and untracked files. A coordinator can override the spec with `orca_config {watchdog: {scopeGlobs:[...]}}`. The watchdog does not run when no policy is supplied; an unreadable scoped worktree reports one `scope` finding instead of silently claiming success. Remote/unmounted worktrees cannot be assessed locally.
- **Stall:** a worker still reported as `working` whose normalized terminal screen (spinner, clocks, status footer and pi-bg card timers removed) is unchanged for 10 minutes.
- **Loop:** repeated waiting phrases such as “Waiting for push completion”, “Waiting on verification” and “Waiting for input” across samples, without visible progress.
- **Waiting for an answer:** capture the question and options from Pi's picker screen, approval prompts (including guarded Git push and agent approvals), pending Orca asks, and a worker that becomes idle after a plain-text question. The wake message includes visible question text and options so the coordinator can decide whether to answer or select in the worker terminal.
- **Closure debt:** accepted completion or a proven terminal exit without release/closure.
- **Activity:** recent heartbeat/status timestamps from the Dispatch reset the unchanged-activity clock even if the same screen text remains visible. Human-owned terminals are excluded from automated stall, loop and scope findings.
- **Deduplication:** continuous findings are sent once; a cleared and recurring finding is subject to the configured cooldown (30 minutes by default). New watchdog findings bypass the ordinary fleet wake budget so they actually wake the coordinator. Configuration lives in `orca/watchdog.json` and per-Run state in `orca/watchdog-<runId>.json` below `PI_BG_STATE_DIR`; no state is written to worker repositories.

`orca_config {watchdog}` configures `enabled`, scan cadence, stall/loop thresholds, repeat count, closure grace, cooldown and scope globs. Current bounds are validated/clamped. An unavailable scope read is not presented as a clean scan.

## Model evidence on the card

Display model and thinking evidence in this order: explicit launch `--model`/thinking options recorded by Orca, the model and thinking level visible in that worker's Pi status bar, then that Pi worker's project profile and personal profile defaults. Only the profile-default fallback is marked “(por defecto)”. A reused terminal never receives a guessed profile default. The coordinator's live model is never used as a worker model.

## Cheap workflow wins selected

1. **`orca_release`** — one explicit call releases one settled Dispatch or all reclaimable settled Dispatches. It uses `worker-release` first. Only `release_unknown`/`retained` plus a fresh `exited` verdict for the same non-human-owned terminal permits the narrow `terminal close` fallback. A live, unsettled or unverifiable terminal is never force-closed.
2. **`orca_screen`** — returns a bounded worker terminal tail with spinner/footer noise removed while preserving prompts and choices; this replaces repeated manual `worker-read` calls for quick inspection.
3. **`orca_config {label}`** — sets a short current-focus label that survives reload. Without an override, the card uses active Task titles rather than the immutable Run-creation objective.

These are additive coordinator tools, not background automation. Release still requires the coordinator to choose it explicitly.

## Deferred simplifications

- **`orca_start`:** worktree creation, branch policy, notes, dispatch, terminal rename and watch registration combine several lifecycle mutations; defer until there is a clear rollback/partial-failure contract.
- **`orca_steer`:** a terminal-send fallback after mailbox errors can type into an active composer or approval UI; keep mailbox enqueue and explicit terminal interaction separate.
- **Worker-side inbox replacement:** the worker-side `check --terminal` path has shown `stable_pane_required` and `consumer_fenced`. Do not invent a local fallback or rebind a worker; first agree an Orca-supported worker inbox contract.

## Verification

Pure tests cover resolver precedence, activity timestamps, scope glob matching and Git inventory (committed/uncommitted/untracked), screen/loop/prompt/closure findings, question+option extraction from captured screen fixtures, cooldown behavior, and release fallback safety. Fake-Orca extension tests cover explicit cleanup and coordinator notices without contacting a production Run. The manual Orca plan remains in `docs/manual-test-plan.md`; run it only with a throwaway Run.
