+1 to this direction. We hit the same gap with a Pi coordinator that supervises Orca workers. Both the coordinator and each worker run in-process subagents and long background shell watchers, such as CI watches and verify gates. Today those panes read "working" or "done" with nothing under them, so the user cannot tell a busy lead from a stuck one.

One data point on step 1. On 1.4.212 the generated extension learns about children only from `task:subagent:lifecycle` and `subagent:async-started` / `subagent:async-complete` on `pi.events`. Those names come from specific subagent packages. Pi itself has no standard child-lifecycle event, so any other extension that runs children (subagents, background tasks, watchers) is invisible to Orca today. Could the new lane pin a small, documented event contract that any Pi extension can emit, with an id, a `kind` of `task` or `watch`, a state, `startedAt`, and optional `agentType` / `model` / `description`? The parity table or `docs/reference/agent-status-store.md` would be a good home for it.

The `task` / `watch` split fits our case well. Background shell watchers are exactly the `watch` children you describe, and they should not hold the pane "working" forever.

Once the shape lands we would emit it from our Pi extensions, and we are happy to test a build on Linux (1.4.212).
