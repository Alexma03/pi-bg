import { test } from "node:test";
import assert from "node:assert/strict";
import { addWatch, initialFleet, parseTasks, parseWorkerRow, parseWorkerShow, parseOrcaTime, parseWorkerPage, readyTasks, summarize, summaryLine, updateFleet, type FleetState, type TaskRow, type WorkerRow } from "../lib/orca/fleet.ts";

const MIN = 60_000;
const row = (id: string, extra: Partial<WorkerRow> = {}): WorkerRow => ({
	dispatchId: id,
	taskId: `task_${id}`,
	runId: "run_r",
	workerState: "ready",
	dispatchStatus: "dispatched",
	terminalState: "active",
	terminalHandle: `term_${id}`,
	activity: "working",
	outcome: "in_progress",
	liveness: "live",
	livenessReason: "",
	observedAt: null,
	attention: [],
	requiresAction: false,
	nextAction: "none",
	ownership: "owned",
	provider: "pi",
	...extra,
});
const task = (id: string, extra: Partial<TaskRow> = {}): TaskRow => ({ id, title: id.toUpperCase(), spec: "", status: "dispatched", deps: [], parentId: null, ...extra });

function poll(state: FleetState, rows: WorkerRow[], now: number, tasks?: TaskRow[]) {
	return updateFleet(state, rows, tasks, now);
}

test("parses worker-list pages and task-list rows", () => {
	const page = parseWorkerPage({
		workers: [
			{
				dispatchId: "ctx_1",
				taskId: "task_1",
				runId: "run_r",
				workerState: "ready",
				dispatchStatus: "dispatched",
				terminalState: "retained",
				agentTerminalHandle: "term_1",
				resource: { ownershipState: "external" },
				lastStatusAt: "2026-09-27 16:18:16",
				pendingInput: { question: "Proceed with the migration?", options: ["Continue", "Stop"] },
				projection: { stage: { activity: "done" }, outcome: "in_progress", liveness: { verdict: "live", observedAt: 123 }, attention: { categories: ["input"], requiresAction: true }, nextAction: { kind: "none" }, provider: { id: "pi" } },
			},
			{ nope: true },
		],
		page: { hasMore: true, nextCursor: "ctx_1" },
	});
	assert.equal(page.rows.length, 1);
	assert.equal(page.rows[0].activity, "done");
	assert.equal(page.rows[0].observedAt, 123);
	assert.equal(page.rows[0].activityAt, Date.parse("2026-09-27T16:18:16Z"));
	assert.equal(page.rows[0].pendingQuestion, "Proceed with the migration?");
	assert.deepEqual(page.rows[0].questionOptions, ["Continue", "Stop"]);
	assert.deepEqual(page.rows[0].attention, ["input"]);
	assert.equal(page.hasMore, true);
	assert.equal(page.nextCursor, "ctx_1");
	const tasks = parseTasks({ tasks: [{ id: "task_1", display_name: "A0", spec: "Do A0", status: "pending", deps: '["task_0"]', parent_id: null }] });
	assert.deepEqual(tasks, [{ id: "task_1", title: "A0", spec: "Do A0", status: "pending", deps: ["task_0"], parentId: null }]);
});

test("worker-show gives agent, model and dispatch time (Orca UTC without zone)", () => {
	const detail = parseWorkerShow({
		dispatch: { dispatchedAt: "2026-09-27 16:15:16", createdAt: "2026-09-27 16:15:10" },
		worker: { startOptions: { agent: "pi", launch: { requested: { agent: "pi", model: null }, effective: { agent: "pi", model: "wrong-session-model", effort: "high" } } } },
	});
	assert.deepEqual(detail, { agent: "pi", model: "", effort: "", startedAt: Date.parse("2026-09-27T16:15:16Z"), reusedTerminal: false });
	const explicit = parseWorkerShow({
		worker: { startOptions: { agent: "pi", launch: { requested: { agent: "pi", model: "gpt-6-luna" }, effective: { agent: "pi", provider: "openai-codex", model: "gpt-6-luna", effort: "max" } } } },
	});
	assert.deepEqual(explicit, { agent: "pi", model: "gpt-6-luna", provider: "openai-codex", effort: "max", startedAt: null, reusedTerminal: false });
	assert.equal(parseOrcaTime("2026-09-27T16:16:43.690Z"), Date.parse("2026-09-27T16:16:43.690Z"));
	assert.equal(parseOrcaTime(null), null);
	assert.deepEqual(parseWorkerShow({}), { agent: "", model: "", effort: "", startedAt: null, reusedTerminal: false });
	const fromCommand = parseWorkerShow({ worker: { command: "pi --model openai-codex/gpt-6-luna --thinking max", startOptions: { agent: "pi", launch: { requested: {}, effective: {} } } } });
	assert.equal(fromCommand.model, "openai-codex/gpt-6-luna", "an explicit command flag is launch evidence even if requested metadata is absent");
	assert.equal(fromCommand.effort, "max", "the launch command's thinking level is shown too");
	const pending = parseWorkerShow({ dispatch: { pendingInput: { question: "Can I change the API?", options: ["Yes", "No"] } }, observation: { agentWait: { promptText: "waiting" } } });
	assert.equal(pending.pendingQuestion, "Can I change the API?");
	assert.deepEqual(pending.questionOptions, ["Yes", "No"]);
	// Dispatched with --terminal: Orca did not launch the agent, so its model is unknown.
	assert.equal(parseWorkerShow({ worker: { startOptions: { terminal: "term_x", agent: null, launch: { requested: {}, effective: {} } } } }).reusedTerminal, true);
});

test("a worker that ends its turn without worker_done is reported once after 3 minutes", () => {
	let s = poll(initialFleet(), [row("a")], 0, [task("task_a")]).state;
	let r = poll(s, [row("a", { activity: "done" })], 1 * MIN);
	assert.deepEqual(r.events, []);
	r = poll(r.state, [row("a", { activity: "done" })], 4 * MIN + 1);
	const stalled = r.events.filter((e) => e.kind === "stalled");
	assert.equal(stalled.length, 1);
	assert.equal(stalled[0].title, "TASK_A");
	assert.ok((stalled[0].sinceMs ?? 0) >= 3 * MIN);
	// Same episode: no repeat.
	r = poll(r.state, [row("a", { activity: "done" })], 10 * MIN);
	assert.equal(r.events.filter((e) => e.kind === "stalled").length, 0);
	// Working again, then idle again: a new episode.
	r = poll(r.state, [row("a", { activity: "working" })], 11 * MIN);
	assert.equal(r.events[0]?.kind, "resumed");
	r = poll(r.state, [row("a", { activity: "idle" })], 12 * MIN);
	r = poll(r.state, [row("a", { activity: "idle" })], 16 * MIN);
	assert.equal(r.events.filter((e) => e.kind === "stalled").length, 1);
	s = r.state;
	void s;
});

test("the stall clock uses the hook observation time after a restart", () => {
	const r = poll(initialFleet(), [row("a", { activity: "done", observedAt: 0 })], 5 * MIN);
	assert.equal(r.events.filter((e) => e.kind === "stalled").length, 1);
});

test("recent heartbeat/status timestamps count as activity while the state label stays the same", () => {
	let state = poll(initialFleet(), [row("a", { activity: "working", activityAt: 0 })], 0).state;
	state = poll(state, [row("a", { activity: "working", activityAt: 9 * MIN })], 10 * MIN).state;
	assert.equal(state.workers.get("a")?.activitySince, 9 * MIN);
	const parsed = parseWorkerRow({ dispatchId: "ctx_message", lastHeartbeatAt: "2026-09-27 16:15:16", lastStatusAt: "2026-09-27 16:17:16", projection: { liveness: { verdict: "live", observedAt: 1 }, stage: { activity: "working" } } });
	assert.equal(parsed?.activityAt, Date.parse("2026-09-27T16:17:16Z"));
});

test("blocked prompts are reported after one minute; human-owned terminals are not", () => {
	let r = poll(initialFleet(), [row("a", { activity: "blocked" }), row("b", { activity: "blocked", ownership: "user_owned" })], 0);
	r = poll(r.state, [row("a", { activity: "blocked" }), row("b", { activity: "blocked", ownership: "user_owned" })], 2 * MIN);
	const blocked = r.events.filter((e) => e.kind === "blocked");
	assert.deepEqual(blocked.map((e) => e.dispatchId), ["a"]);
});

test("exited without worker_done, attention and release debt", () => {
	let r = poll(initialFleet(), [row("a"), row("b"), row("c")], 0);
	r = poll(r.state, [row("a", { liveness: "exited", nextAction: "recover" }), row("b", { requiresAction: true, attention: ["approval"] }), row("c", { outcome: "succeeded", workerState: "succeeded", dispatchStatus: "completed", nextAction: "release" })], 1 * MIN);
	const kinds = r.events.map((e) => `${e.kind}:${e.dispatchId}`).sort();
	assert.ok(kinds.includes("exited:a"));
	assert.ok(kinds.includes("attention:b"));
	assert.ok(kinds.includes("settled:c"));
	assert.ok(!kinds.includes("release:c"), "release has a grace period");
	r = poll(r.state, [row("a", { liveness: "exited" }), row("b", { requiresAction: true, attention: ["approval"] }), row("c", { outcome: "succeeded", workerState: "succeeded", nextAction: "release" })], 5 * MIN);
	assert.deepEqual(r.events.map((e) => `${e.kind}:${e.dispatchId}`), ["release:c"]);
});

test("the first poll reports current problems but not settled history", () => {
	const r = poll(initialFleet(), [row("old", { outcome: "succeeded", workerState: "succeeded", attention: ["unverifiable", "root_completion"], requiresAction: true, liveness: "unverifiable" })], 0);
	assert.deepEqual(r.events, []);
});

test("fleet idle fires once when every open worker is quiet", () => {
	let r = poll(initialFleet(), [row("a", { activity: "done" }), row("b", { activity: "idle" })], 0);
	r = poll(r.state, [row("a", { activity: "done" }), row("b", { activity: "idle" })], 4 * MIN);
	assert.equal(r.events.filter((e) => e.kind === "fleet_idle").length, 1);
	r = poll(r.state, [row("a", { activity: "done" }), row("b", { activity: "idle" })], 6 * MIN);
	assert.equal(r.events.filter((e) => e.kind === "fleet_idle").length, 0);
});

test("ready tasks without a worker are reported when nothing runs", () => {
	const tasks = [task("t1", { status: "completed" }), task("t2", { status: "pending", deps: ["t1"] }), task("t3", { status: "pending", deps: ["t2"] })];
	let r = poll(initialFleet(), [], 0, tasks);
	assert.deepEqual(readyTasks(r.state).map((t) => t.id), ["t2"]);
	assert.equal(r.events[0]?.kind, "ready_tasks");
	r = poll(r.state, [], 1 * MIN);
	assert.deepEqual(r.events, []);
});

test("orca_watch notes ride on events and end when the worker settles", () => {
	let s = poll(initialFleet(), [row("a")], 0).state;
	s = addWatch(s, { dispatchId: "a", on: ["settled"], note: "then start the A1 review", createdAt: 0 });
	const r = poll(s, [row("a", { outcome: "succeeded", workerState: "succeeded", dispatchStatus: "completed" })], 1 * MIN);
	const settled = r.events.find((e) => e.kind === "settled");
	assert.deepEqual(settled?.notes, ["then start the A1 review"]);
	assert.equal(r.state.watches.length, 0);
});

test("watch any reports activity changes", () => {
	let s = poll(initialFleet(), [row("a")], 0).state;
	s = addWatch(s, { dispatchId: "a", on: ["any"], note: "", createdAt: 0 });
	const r = poll(s, [row("a", { activity: "done" })], 10_000);
	assert.equal(r.events[0]?.kind, "resumed");
	assert.match(r.events[0]?.detail ?? "", /working → done/);
});

test("summary line", () => {
	let r = poll(initialFleet(), [row("a"), row("b", { activity: "done" }), row("c", { outcome: "succeeded", workerState: "succeeded", nextAction: "release" })], 0);
	r = poll(r.state, [row("a"), row("b", { activity: "done" }), row("c", { outcome: "succeeded", workerState: "succeeded", nextAction: "release" })], 4 * MIN);
	assert.equal(summaryLine(summarize(r.state, 4 * MIN)), "2 open · 1 working · 1 stalled · 1 to release");
});

test("a worker whose status went stale (30 min without a hook post) counts as stalled", () => {
	let r = poll(initialFleet(), [row("a")], 0);
	r = poll(r.state, [row("a", { activity: "unknown", liveness: "unverifiable", livenessReason: "stale_status" })], 40 * MIN);
	assert.equal(r.events.filter((e) => e.kind === "stalled").length, 1);
	assert.equal(summarize(r.state, 40 * MIN).stalled, 1);
});

import { seedSeen } from "../lib/orca/fleet.ts";

test("keys seen before a reload are not reported again", () => {
	let r = poll(initialFleet(), [row("a", { activity: "done", observedAt: 0 })], 5 * MIN);
	const reported = r.events.filter((e) => e.key).map((e) => ({ ...(e.dispatchId ? { dispatchId: e.dispatchId } : {}), key: e.key as string }));
	assert.ok(reported.length >= 1);
	// A fresh runtime (reload) seeded with those keys stays quiet for the same episode.
	const fresh = seedSeen(initialFleet(), reported);
	r = poll(fresh, [row("a", { activity: "done", observedAt: 0 })], 6 * MIN);
	assert.deepEqual(r.events, []);
});
