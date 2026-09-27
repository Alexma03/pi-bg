import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildCard, renderCardLines } from "../lib/ui/card.ts";
import { initialState } from "../lib/orca/machine.ts";
import { initialFleet, updateFleet, type WorkerRow } from "../lib/orca/fleet.ts";
import type { TaskSnapshot } from "../lib/tasks/manager.ts";

const task = (id: string, extra: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
	id,
	label: id,
	command: "sleep 1",
	cwd: "/tmp",
	pid: 1,
	status: "running",
	startedAt: 0,
	endedAt: undefined,
	exitCode: null,
	signal: null,
	logPath: "/tmp/x.log",
	bytes: 0,
	watch: undefined,
	watchEvents: 0,
	...extra,
});

const worker = (id: string, extra: Partial<WorkerRow> = {}): WorkerRow => ({
	dispatchId: id, taskId: `task_${id}`, runId: "run_r", workerState: "ready", dispatchStatus: "dispatched", terminalState: "active", terminalHandle: "", activity: "working", outcome: "in_progress", liveness: "live", livenessReason: "", observedAt: null, attention: [], requiresAction: false, nextAction: "none", ownership: "owned", provider: "pi", ...extra,
});

const plainTheme = { fg: (_c: string, t: string) => t };

test("no card when nothing runs and the bridge is off", () => {
	assert.equal(buildCard({ now: 0, tasks: [], orca: initialState() }), undefined);
});

test("running and failed tasks, bridge pending, stalled worker", () => {
	const orca = { ...initialState(), phase: "pending" as const, runId: "run_8da5785a70be", pending: { id: "delivery_1", runId: "run_8da5785a70be", messages: [], replayed: false }, pendingSince: 0 };
	let fleet = updateFleet(initialFleet(), [worker("a", { activity: "done" }), worker("b")], [], 0).state;
	fleet = updateFleet(fleet, [worker("a", { activity: "done" }), worker("b")], undefined, 5 * 60_000).state;
	const card = buildCard({
		now: 5 * 60_000,
		tasks: [task("bg1", { label: "verify" }), task("bg2", { status: "exited", exitCode: 2, endedAt: 5 * 60_000 - 1000 })],
		lastLines: new Map([["bg1", "ok 12/40"]]),
		orca,
		fleet,
	});
	assert.ok(card);
	assert.equal(card.tone, "warning");
	const text = card.rows.map((r) => r.text).join("\n");
	assert.match(text, /▸ bg1 verify · 5m00s · ok 12\/40/);
	assert.match(text, /✖ bg2 · exited 2/);
	assert.match(text, /delivery delivery_1 awaiting orca_ack · 5m00s/);
	assert.match(text, /fleet · 2 open · 1 working · 1 stalled/);
	assert.match(text, /⏸ task_a · done 5m00s/);
	const lines = renderCardLines(card, plainTheme, 60);
	assert.ok(lines[0].startsWith("╭─ ⏵ Background · 1 bg · orca"));
	assert.ok(lines.every((l) => visibleWidth(l) === 60), lines.join("\n"));
});

test("collapsed card keeps only problems", () => {
	const card = buildCard({ now: 1000, tasks: [task("bg1")], orca: { ...initialState(), phase: "fenced", runId: "run_x", reason: "not the Run consumer" }, collapsed: true });
	assert.ok(card);
	assert.deepEqual(card.rows.map((r) => r.text), ["⇄ orca run_x · not the Run consumer", "… 1 more (/bg, orca_workers)"]);
});
