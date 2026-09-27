import { test } from "node:test";
import assert from "node:assert/strict";
import { ageBucket, stateBlock } from "../lib/state-block.ts";
import { initialState } from "../lib/orca/machine.ts";
import { initialFleet, updateFleet, type WorkerRow } from "../lib/orca/fleet.ts";

const worker = (id: string, extra: Partial<WorkerRow> = {}): WorkerRow => ({
	dispatchId: id, taskId: `task_${id}`, runId: "run_r", workerState: "ready", dispatchStatus: "dispatched", terminalState: "active", terminalHandle: "", activity: "working", outcome: "in_progress", liveness: "live", livenessReason: "", observedAt: null, attention: [], requiresAction: false, nextAction: "none", ownership: "owned", provider: "pi", ...extra,
});

test("empty state adds nothing to the prompt", () => {
	assert.equal(stateBlock({ now: 0, tasks: [], orca: initialState() }), undefined);
});

test("pending delivery and a quiet worker are named; ages are bucketed", () => {
	let fleet = updateFleet(initialFleet(), [worker("a", { activity: "done" })], [], 0).state;
	fleet = updateFleet(fleet, [worker("a", { activity: "done" })], undefined, 7 * 60_000).state;
	const orca = { ...initialState(), phase: "pending" as const, runId: "run_r", pending: { id: "delivery_9", runId: "run_r", messages: [], replayed: false } };
	const text = stateBlock({ now: 7 * 60_000, tasks: [], orca, fleet }) ?? "";
	assert.match(text, /Orca delivery delivery_9 is pending/);
	assert.match(text, /Orca fleet: 1 open · 0 working · 1 stalled; not working: task_a done 5-15m/);
	// Same bucket a minute later: identical text (stable prompt cache).
	assert.equal(stateBlock({ now: 8 * 60_000, tasks: [], orca, fleet }), text);
	assert.equal(ageBucket(30_000), "<1m");
	assert.equal(ageBucket(2 * 3600_000), ">1h");
});
