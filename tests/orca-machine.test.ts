import { test } from "node:test";
import assert from "node:assert/strict";
import type { CheckOutcome } from "../lib/orca/cli.ts";
import type { Delivery, OrcaMessage } from "../lib/orca/delivery.ts";
import { initialState, REMIND_AFTER_MS, step, type Effect, type OrcaEvent, type OrcaState } from "../lib/orca/machine.ts";

const fixed = () => 0.5; // no jitter
const m = (id: string, type: string): OrcaMessage => ({ id, type, from: "term_w", to: "run:r", subject: type, body: "", payload: "", priority: "normal", threadId: "", createdAt: "" });
const d = (id: string, types: string[], replayed = false): Delivery => ({ id, runId: "run_r", messages: types.map((t, i) => m(`${id}_m${i}`, t)), replayed });
const got = (delivery: Delivery, acknowledged: string | null = null): CheckOutcome => ({ kind: "delivery", delivery, acknowledged });
const timeout: CheckOutcome = { kind: "empty", acknowledged: null, timedOut: true, cancelled: false, connectionLost: false };
const error = (code: string): CheckOutcome => ({ kind: "error", code, message: code });

function run(state: OrcaState, ...events: OrcaEvent[]): { state: OrcaState; effects: Effect[][] } {
	const effects: Effect[][] = [];
	for (const event of events) {
		const r = step(state, event, fixed);
		state = r.state;
		effects.push(r.effects);
	}
	return { state, effects };
}

const enabled = (): OrcaState => step(initialState(), { type: "enable", runId: "run_r", explicit: false }, fixed).state;

test("enable spawns exactly one unfiltered waiter", () => {
	const r = step(initialState(), { type: "enable", runId: "run_r", explicit: false }, fixed);
	assert.equal(r.state.phase, "waiting");
	assert.deepEqual(r.effects, [{ type: "cancelSchedule" }, { type: "killWaiter" }, { type: "spawnWait", ack: null }]);
	// Re-enabling the same Run while active is a no-op.
	assert.deepEqual(step(r.state, { type: "enable", runId: "run_r", explicit: false }, fixed).effects, []);
});

test("timeouts re-arm immediately without an ack", () => {
	const r = step(enabled(), { type: "waitResult", outcome: timeout, sentAck: null, now: 1 }, fixed);
	assert.equal(r.state.phase, "waiting");
	assert.deepEqual(r.effects, [{ type: "spawnWait", ack: null }]);
});

test("heartbeat-only batches are acked silently by the next wait", () => {
	const hb = d("dh", ["heartbeat", "heartbeat"]);
	const r = step(enabled(), { type: "waitResult", outcome: got(hb), sentAck: null, now: 1 }, fixed);
	assert.equal(r.state.phase, "waiting");
	assert.equal(r.state.heartbeatsAcked, 2);
	assert.deepEqual(r.effects, [{ type: "spawnWait", ack: "dh" }]);
	// The carried ack is cleared once a wait carrying it returns.
	const after = step(r.state, { type: "waitResult", outcome: { ...timeout, acknowledged: "dh" }, sentAck: "dh", now: 2 }, fixed);
	assert.equal(after.state.ackCarry, null);
	assert.deepEqual(after.effects, [{ type: "spawnWait", ack: null }]);
});

test("an actionable batch is injected and holds the mailbox until orca_ack", () => {
	const batch = d("d1", ["heartbeat", "worker_done"]);
	const r = run(enabled(), { type: "waitResult", outcome: got(batch), sentAck: null, now: 10 });
	assert.equal(r.state.phase, "pending");
	assert.equal(r.state.pending?.id, "d1");
	assert.deepEqual(r.effects[0], [{ type: "inject", delivery: batch }]);
	// No waiter is spawned while pending: the outstanding delivery suppresses Orca's pointer.
	assert.ok(!r.effects[0].some((e) => e.type === "spawnWait"));
});

test("orca_ack acks synchronously, then re-arms", () => {
	const pending = run(enabled(), { type: "waitResult", outcome: got(d("d1", ["worker_done"])), sentAck: null, now: 10 }).state;
	const asked = step(pending, { type: "ackRequest", deliveryId: "d1", now: 11 }, fixed);
	assert.equal(asked.state.phase, "acking");
	assert.deepEqual(asked.effects, [{ type: "runAck", deliveryId: "d1" }]);
	const done = step(asked.state, { type: "ackResult", outcome: { kind: "empty", acknowledged: "d1", timedOut: false, cancelled: false, connectionLost: false }, deliveryId: "d1", now: 12 }, fixed);
	assert.equal(done.state.phase, "waiting");
	assert.equal(done.state.pending, null);
	assert.deepEqual(done.effects[0], { type: "spawnWait", ack: null });
	assert.equal(done.effects[1].type, "ackReply");
	assert.equal((done.effects[1] as { ok: boolean }).ok, true);
});

test("orca_ack returns an already-waiting next batch inline instead of injecting it", () => {
	const pending = run(enabled(), { type: "waitResult", outcome: got(d("d1", ["worker_done"])), sentAck: null, now: 10 }, { type: "ackRequest", deliveryId: "d1", now: 11 }).state;
	const next = d("d2", ["question"]);
	const r = step(pending, { type: "ackResult", outcome: got(next, "d1"), deliveryId: "d1", now: 12 }, fixed);
	assert.equal(r.state.phase, "pending");
	assert.equal(r.state.pending?.id, "d2");
	assert.equal(r.effects.length, 1);
	const reply = r.effects[0] as Extract<Effect, { type: "ackReply" }>;
	assert.equal(reply.type, "ackReply");
	assert.equal(reply.ok, true);
	assert.equal(reply.next?.id, "d2");
	assert.ok(!r.effects.some((e) => e.type === "inject"));
});

test("orca_ack with a heartbeat-only next batch re-arms with that ack", () => {
	const pending = run(enabled(), { type: "waitResult", outcome: got(d("d1", ["status"])), sentAck: null, now: 10 }, { type: "ackRequest", deliveryId: "d1", now: 11 }).state;
	const r = step(pending, { type: "ackResult", outcome: got(d("d2", ["heartbeat"]), "d1"), deliveryId: "d1", now: 12 }, fixed);
	assert.equal(r.state.phase, "waiting");
	assert.deepEqual(r.effects[0], { type: "spawnWait", ack: "d2" });
});

test("orca_ack rejects wrong ids and keeps the delivery pending on failure", () => {
	const pending = run(enabled(), { type: "waitResult", outcome: got(d("d1", ["worker_done"])), sentAck: null, now: 10 }).state;
	const wrong = step(pending, { type: "ackRequest", deliveryId: "dX", now: 11 }, fixed);
	assert.equal(wrong.state.phase, "pending");
	assert.equal((wrong.effects[0] as { ok: boolean }).ok, false);
	const acking = step(pending, { type: "ackRequest", deliveryId: "d1", now: 11 }, fixed).state;
	const failed = step(acking, { type: "ackResult", outcome: error("transport"), deliveryId: "d1", now: 12 }, fixed);
	assert.equal(failed.state.phase, "pending");
	assert.equal((failed.effects[0] as { ok: boolean }).ok, false);
	// Same delivery still outstanding: the ack did not apply.
	const same = step(acking, { type: "ackResult", outcome: got(d("d1", ["worker_done"])), deliveryId: "d1", now: 12 }, fixed);
	assert.equal(same.state.phase, "pending");
	assert.equal((same.effects[0] as { ok: boolean }).ok, false);
});

test("ack without a pending delivery is refused", () => {
	const r = step(enabled(), { type: "ackRequest", deliveryId: "d1", now: 1 }, fixed);
	assert.equal(r.state.phase, "waiting");
	assert.equal((r.effects[0] as { ok: boolean }).ok, false);
});

test("replays are re-injected with a visible note, never silently", () => {
	// Orca-flagged replay (e.g. after /reload): note present.
	const r1 = step(enabled(), { type: "waitResult", outcome: got(d("d1", ["worker_done"], true)), sentAck: null, now: 1 }, fixed);
	const inject1 = r1.effects[0] as Extract<Effect, { type: "inject" }>;
	assert.match(inject1.note ?? "", /REPLAY/);
	// Replay after an ack attempt in this runtime.
	const acking = step(r1.state, { type: "ackRequest", deliveryId: "d1", now: 2 }, fixed).state;
	const back = step(acking, { type: "ackResult", outcome: error("transport"), deliveryId: "d1", now: 3 }, fixed).state;
	const disabled = step(back, { type: "disable", reason: "test" }, fixed).state;
	const again = run(disabled, { type: "enable", runId: "run_r", explicit: false }, { type: "waitResult", outcome: got(d("d1", ["worker_done"])), sentAck: null, now: 4 });
	const inject2 = again.effects[1][0] as Extract<Effect, { type: "inject" }>;
	assert.equal(inject2.type, "inject");
	assert.match(inject2.note ?? "", /after an acknowledgment attempt/);
});

test("waiter_exists backs off on its own slower policy", () => {
	const r = step(enabled(), { type: "waitResult", outcome: error("waiter_exists"), sentAck: null, now: 1000 }, fixed);
	assert.equal(r.state.phase, "backoff");
	assert.equal(r.state.reason, "another waiter holds this Run");
	assert.deepEqual(r.effects, [{ type: "schedule", delayMs: 15_000 }]);
	const retry = step(r.state, { type: "retry", now: 16_000 }, fixed);
	assert.equal(retry.state.phase, "waiting");
	assert.deepEqual(retry.effects, [{ type: "spawnWait", ack: null }]);
});

test("transport errors back off exponentially and keep then drop the carried ack", () => {
	const carrying = step(enabled(), { type: "waitResult", outcome: got(d("dh", ["heartbeat"])), sentAck: null, now: 0 }, fixed).state;
	const e1 = step(carrying, { type: "waitResult", outcome: error("transport"), sentAck: "dh", now: 1 }, fixed);
	assert.deepEqual(e1.effects, [{ type: "schedule", delayMs: 1_000 }]);
	assert.equal(e1.state.ackCarry, "dh");
	const r1 = step(e1.state, { type: "retry", now: 2 }, fixed);
	assert.deepEqual(r1.effects, [{ type: "spawnWait", ack: "dh" }]);
	const e2 = step(r1.state, { type: "waitResult", outcome: error("transport"), sentAck: "dh", now: 3 }, fixed);
	assert.deepEqual(e2.effects, [{ type: "schedule", delayMs: 2_000 }]);
	assert.equal(e2.state.ackCarry, null);
	// Success resets the attempt counter.
	const ok = run(e2.state, { type: "retry", now: 4 }, { type: "waitResult", outcome: timeout, sentAck: null, now: 5 });
	assert.equal(ok.state.attempt, 0);
});

test("fence codes stop the loop and ask the driver to re-detect", () => {
	const r = step(enabled(), { type: "waitResult", outcome: error("consumer_fenced"), sentAck: null, now: 1 }, fixed);
	assert.equal(r.state.phase, "fenced");
	assert.deepEqual(r.effects, [{ type: "cancelSchedule" }, { type: "killWaiter" }, { type: "redetect", delayMs: 5_000 }]);
	// Explicit runs are not re-detected.
	const explicit = step(initialState(), { type: "enable", runId: "run_r", explicit: true }, fixed).state;
	const f = step(explicit, { type: "waitResult", outcome: error("stable_pane_required"), sentAck: null, now: 1 }, fixed);
	assert.ok(!f.effects.some((e) => e.type === "redetect"));
	// A fenced bridge can be re-enabled on the same Run.
	assert.equal(step(r.state, { type: "enable", runId: "run_r", explicit: false }, fixed).state.phase, "waiting");
});

test("results arriving outside the waiting phase are ignored", () => {
	const off = step(enabled(), { type: "disable", reason: "x" }, fixed).state;
	const r = step(off, { type: "waitResult", outcome: got(d("d1", ["worker_done"])), sentAck: null, now: 1 }, fixed);
	assert.equal(r.state.phase, "off");
	assert.deepEqual(r.effects, []);
});

test("a heartbeat batch replayed right after its ack backs off instead of spinning", () => {
	const carrying = step(enabled(), { type: "waitResult", outcome: got(d("dh", ["heartbeat"])), sentAck: null, now: 0 }, fixed).state;
	const r = step(carrying, { type: "waitResult", outcome: got(d("dh", ["heartbeat"])), sentAck: "dh", now: 1 }, fixed);
	assert.equal(r.state.phase, "backoff");
});

test("one reminder after a long pending delivery", () => {
	const pending = run(enabled(), { type: "waitResult", outcome: got(d("d1", ["worker_done"])), sentAck: null, now: 0 }).state;
	assert.deepEqual(step(pending, { type: "tick", now: REMIND_AFTER_MS - 1 }, fixed).effects, []);
	const r = step(pending, { type: "tick", now: REMIND_AFTER_MS }, fixed);
	assert.equal(r.effects[0].type, "remind");
	assert.deepEqual(step(r.state, { type: "tick", now: REMIND_AFTER_MS * 2 }, fixed).effects, []);
});
