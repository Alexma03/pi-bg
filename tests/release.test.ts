import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseFallbackAllowed, releaseOne, releaseSelection, releaseStatus } from "../lib/orca/release.ts";
import type { WorkerRow } from "../lib/orca/fleet.ts";

const row = (id: string, extra: Partial<WorkerRow> = {}): WorkerRow => ({
	dispatchId: id, taskId: `task_${id}`, runId: "run_r", workerState: "succeeded", dispatchStatus: "completed", terminalState: "release_unknown", terminalHandle: `term_${id}`,
	activity: "done", outcome: "succeeded", liveness: "exited", livenessReason: "process_exited", observedAt: null, attention: [], requiresAction: false, nextAction: "release", ownership: "owned", provider: "pi", ...extra,
});

test("release tool selects one explicit settled worker or every reclaimable settled worker", () => {
	const rows = [row("a"), row("b", { terminalState: "active", nextAction: "none" }), row("c", { outcome: "failed", workerState: "failed", terminalState: "reclaimable" })];
	assert.deepEqual(releaseSelection(rows, { dispatchId: "a" }).map((r) => r.dispatchId), ["a"]);
	assert.deepEqual(releaseSelection(rows, { all: true }).map((r) => r.dispatchId), ["a", "c"]);
	assert.throws(() => releaseSelection(rows, {}), /choose dispatchId or all/);
	assert.throws(() => releaseSelection(rows, { dispatchId: "missing" }), /not reclaimable/);
});

test("release_unknown and retained fall back only after fresh positive exit evidence", () => {
	const exited = row("a");
	assert.equal(releaseFallbackAllowed(exited, "release_unknown"), true);
	assert.equal(releaseFallbackAllowed(exited, "retained"), true);
	assert.equal(releaseFallbackAllowed(row("live", { liveness: "live" }), "release_unknown"), false);
	assert.equal(releaseFallbackAllowed(row("human", { ownership: "user_owned" }), "retained"), false);
	assert.equal(releaseFallbackAllowed(row("unknown-owner", { ownership: "" }), "release_unknown"), false);
	assert.equal(releaseFallbackAllowed(row("no-handle", { terminalHandle: "" }), "release_unknown"), false);
	assert.equal(releaseFallbackAllowed(row("running", { outcome: "in_progress" }), "retained"), false);
	assert.equal(releaseFallbackAllowed(exited, "release_pending"), false);
});

test("native release receipts are classified without confusing retained with success", () => {
	assert.equal(releaseStatus({ ok: true, result: { state: "released" } }, 0), "released");
	assert.equal(releaseStatus({ ok: true, result: { state: "retained" } }, 0), "retained");
	assert.equal(releaseStatus({ ok: false, error: { code: "release_unknown" } }, 1), "release_unknown");
	assert.equal(releaseStatus({ ok: false, error: { code: "release_pending" } }, 1), "release_pending");
	assert.equal(releaseStatus(undefined, 1), "failed");
});

test("release_unknown closes only the same terminal after fresh exited proof", async () => {
	const calls: string[][] = [];
	const resolved: string[] = [];
	const result = await releaseOne(row("a"), {
		run: async (args) => {
			calls.push(args);
			return calls.length === 1 ? { doc: { ok: false, error: { code: "release_unknown" } }, exitCode: 1 } : { doc: { ok: true, result: { closed: true } }, exitCode: 0 };
		},
		refresh: async () => row("a", { liveness: "exited" }),
		resolved: (id) => resolved.push(id),
	});
	assert.equal(result.status, "closed");
	assert.equal(result.resolved, true);
	assert.deepEqual(calls, [
		["orchestration", "worker-release", "--dispatch", "a", "--json"],
		["terminal", "close", "--terminal", "term_a", "--json"],
	]);
	assert.deepEqual(resolved, ["a"]);
});

test("retained worker that is still live is never force-closed", async () => {
	const calls: string[][] = [];
	const result = await releaseOne(row("a"), {
		run: async (args) => { calls.push(args); return { doc: { ok: true, result: { state: "retained" } }, exitCode: 0 }; },
		refresh: async () => row("a", { liveness: "live", terminalState: "retained" }),
		resolved: () => assert.fail("must not mark a live terminal resolved"),
	});
	assert.equal(result.status, "retained");
	assert.equal(result.resolved, false);
	assert.equal(calls.length, 1);
});
