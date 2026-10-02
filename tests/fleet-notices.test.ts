// One notice per worker condition: overlapping detectors are merged, and the
// wake budget defers notices instead of dropping them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeFleetEvents, fleetEventLine, mustWake } from "../lib/orca/fleet-format.ts";
import type { FleetEvent } from "../lib/orca/fleet.ts";
import { createWakeBudget, nextWakeAt, takeWake } from "../lib/wake-budget.ts";

const MIN = 60_000;
const ev = (kind: FleetEvent["kind"], dispatchId?: string, extra: Partial<FleetEvent> = {}): FleetEvent => ({ kind, ...(dispatchId ? { dispatchId } : {}), ...extra });
const shape = (events: FleetEvent[]) => events.map((e) => `${e.kind}:${e.dispatchId ?? "fleet"}`).sort();

test("one batch: the most specific notice per worker condition wins and keeps the notes", () => {
	const memory = new Map<string, number>();
	const out = dedupeFleetEvents(
		[ev("quiet", "a", { notes: ["review A"] }), ev("stall", "a"), ev("blocked", "b"), ev("prompt", "b"), ev("attention", "b", { detail: "input" }), ev("release", "c"), ev("finished", "c"), ev("exited", "d")],
		memory,
		0,
		["a", "b", "x"],
	);
	assert.deepEqual(shape(out), ["exited:d", "finished:c", "prompt:b", "stall:a"]);
	assert.deepEqual(out.find((e) => e.kind === "stall")?.notes, ["review A"]);
});

test("attention that is not about input is its own condition", () => {
	const out = dedupeFleetEvents([ev("prompt", "b"), ev("attention", "b", { detail: "approval" })], new Map(), 0, []);
	assert.deepEqual(shape(out), ["attention:b", "prompt:b"]);
});

test("a later batch does not repeat a condition already reported for that worker", () => {
	const memory = new Map<string, number>();
	dedupeFleetEvents([ev("prompt", "b")], memory, 0, []);
	assert.deepEqual(dedupeFleetEvents([ev("blocked", "b")], memory, 2 * MIN, []), [], "same open question");
	assert.deepEqual(shape(dedupeFleetEvents([ev("blocked", "b")], memory, 11 * MIN, [])), ["blocked:b"], "a new episode after the window");
	const noted = dedupeFleetEvents([ev("blocked", "b", { notes: ["answer it"] })], memory, 12 * MIN, []);
	assert.equal(noted.length, 1, "a watch note is never dropped");
});

test("fleet idle is dropped when every open worker already has its own notice", () => {
	const both = dedupeFleetEvents([ev("stalled", "a"), ev("stalled", "b"), ev("fleet_idle")], new Map(), 0, ["a", "b"]);
	assert.deepEqual(shape(both), ["stalled:a", "stalled:b"]);
	const partial = dedupeFleetEvents([ev("stalled", "a"), ev("fleet_idle")], new Map(), 0, ["a", "b"]);
	assert.deepEqual(shape(partial), ["fleet_idle:fleet", "stalled:a"]);
});

test("an exited worker or one needing attention always wakes", () => {
	assert.equal(mustWake([ev("exited", "a")]), true);
	assert.equal(mustWake([ev("attention", "a", { detail: "approval" })]), true);
	assert.equal(mustWake([ev("stalled", "a")]), false);
});

test("nextWakeAt says when a spent budget frees its oldest slot", () => {
	let b = createWakeBudget(2, 10 * MIN);
	assert.equal(nextWakeAt(b, 0), 0);
	b = takeWake(b, 1 * MIN).budget;
	b = takeWake(b, 3 * MIN).budget;
	assert.equal(nextWakeAt(b, 4 * MIN), 11 * MIN);
	assert.equal(nextWakeAt(b, 12 * MIN), 12 * MIN, "expired slots are free");
});

test("a settled watch note says to skip it if the worker_done delivery was already handled", () => {
	const line = fleetEventLine(ev("settled", "a", { notes: ["launch the A1 review"] }));
	assert.match(line, /launch the A1 review/);
	assert.match(line, /already acted on .*worker_done/);
	assert.doesNotMatch(fleetEventLine(ev("stalled", "a", { notes: ["x"] })), /already acted/);
});
