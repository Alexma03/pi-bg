# Orca 1.4.212 extension points and native integration (research, 2026-09-26)

Produced by a read-only explorer subagent over the extracted app bundle `/tmp/pi-bg-survey/orca-asar`, the CLI help and GitHub. No tokens were printed.

## Plugin system

A real plugin system ships in this build, but it is **EXPERIMENTAL**:

- **Host.** `out/main/plugin-host-entry.js` forks a worker per plugin.
- **Manifest.** `orca-plugin.json` declares panels, commands, events, keybindings, agents and vmRecipes.
- **Capabilities.** A closed set of seven: `workspace:read`, `terminal:send`, `notifications:show`, `storage`, `secrets`, `events:subscribe`, `settings:own`.
- **Events.** Only three: `worktree.created`, `worktree.removed`, `agent.status.changed`.
- **Panels.**
  - A panel is a sandboxed iframe in a sidebar tab, with `connect-src 'none'`.
  - It can call only `workspace.readContext`, `terminal.sendText` and `notifications.show`.
  - Its data must come from the plugin worker, which is a normal Node process with no permission model.
- **Example.** `examples/plugins/hello-orca`.
- **Management.** Only through the Settings UI (there is no `orca plugin` CLI), including development-folder paths.
- **Open items.** Issue #13340 asks whether panels are usable yet. **The biggest unknown** is whether the worker can push arbitrary data to its panel.

## Orca already renders the orchestration hierarchy

- **Dispatch stamping.** Worker panes get an `orchestration` facet (taskId, dispatchId, parentPaneKey, coordinatorHandle, runId, attention).
- **Lineage tree.** `worktree-agent-rows-*.js` builds a tree with depth and siblings. It also synthesises child rows from `subagents[]`.
- **Agent Dashboard / kanban.** It has an attention bucket labelled "Needs You" and a subagent bucket. It is gated by the setting `agentDashboardEnabled`; a popout is experimental.
- **Task DAG** (deps/parent): there is no renderer (see issue #16319).

## Pi subagents in Orca's tree

- **The gap.** `providers/pi-family-events.js` ignores `subagents` in Pi hook payloads; only Claude and Codex build them. The Orca-managed Pi extension `orca-agent-status.ts` tracks subagents but drops them.
- **Workaround.** OSC 9999 status frames accept `subagents`, but they replace the hook row (losing session/resume).
- **Upstream.** Issue #22868 is the right place to fix this.

## Native channel: the runtime RPC socket

- **Discovery.** `~/.config/orca/orca-runtime.json` (0600) lists a unix socket and a websocket, plus an authToken.
- **Wire.** NDJSON, one connection per request, 630 methods (including 38 `orchestration.*`).
- **Subscriptions.** `runtime.clientEvents.subscribe` exists; `orchestration.subscribe` does not.
- **Stability.** It is an internal API with no result schemas. The plugin host API exists precisely to shield plugins from it.

## Worktree metadata

`orca worktree set --parent-worktree / --comment / --workspace-status / --display-name` records parent lineage for worktrees and renders it.

## Ranked options

| Rank | Option | Value / effort |
| --- | --- | --- |
| A | Worktree lineage and metadata | trivial |
| B | Orca plugin (panel + worker) rendering Run → Task → Dispatch → subagent | high value, medium effort, experimental API |
| C | Pi hook `subagents` enrichment | blocked upstream (#22868) |
| D | Thin native socket client instead of CLI spawns | medium effort, internal API |
| E | Upstream asks: #22868, a plugin `orchestration:read` capability, #13340, #23143 | — |
