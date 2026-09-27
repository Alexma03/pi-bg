import { test } from "node:test";
import assert from "node:assert/strict";
import { addWatch, initialFleet, parseTasks, parseWorkerPage, readyTasks, summarize, summaryLine, updateFleet, type FleetState, type TaskRow, type WorkerRow } from "../lib/orca/fleet.ts";

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
const task = (id: string, extra: Partial<TaskRow> = {}): TaskRow => ({ id, title: id.toUpperCase(), status: "dispatched", deps: [], parentId: null, ...extra });

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
				projection: { stage: { activity: "done" }, outcome: "in_progress", liveness: { verdict: "live", observedAt: 123 }, attention: { categories: ["input"], requiresAction: true }, nextAction: { kind: "none" }, provider: { id: "pi" } },
			},
			{ nope: true },
		],
		page: { hasMore: true, nextCursor: "ctx_1" },
	});
	assert.equal(page.rows.length, 1);
	assert.equal(page.rows[0].activity, "done");
	assert.equal(page.rows[0].observedAt, 123);
	assert.deepEqual(page.rows[0].attention, ["input"]);
	assert.equal(page.hasMore, true);
	assert.equal(page.nextCursor, "ctx_1");
	const tasks = parseTasks({ tasks: [{ id: "task_1", display_name: "A0", status: "pending", deps: '["task_0"]', parent_id: null }] });
	assert.deepEqual(tasks, [{ id: "task_1", title: "A0", status: "pending", deps: ["task_0"], parentId: null }]);
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
