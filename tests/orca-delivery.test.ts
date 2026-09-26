import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDelivery, isHeartbeatOnly, typeSummary, type Delivery, type OrcaMessage } from "../lib/orca/delivery.ts";

const msg = (id: string, type: string, extra: Partial<OrcaMessage> = {}): OrcaMessage => ({
	id,
	type,
	from: "term_worker",
	to: "run:run_t",
	subject: `${type} subject`,
	body: "",
	payload: "",
	priority: "normal",
	threadId: "",
	createdAt: "",
	...extra,
});

const delivery = (messages: OrcaMessage[], replayed = false): Delivery => ({ id: "delivery_9", runId: "run_t", messages, replayed });

test("heartbeat-only detection", () => {
	assert.equal(isHeartbeatOnly(delivery([msg("a", "heartbeat"), msg("b", "heartbeat")])), true);
	assert.equal(isHeartbeatOnly(delivery([msg("a", "heartbeat"), msg("b", "status")])), false);
});

test("typeSummary puts urgent types first", () => {
	const d = delivery([msg("a", "status"), msg("b", "worker_done"), msg("c", "question"), msg("d", "worker_done"), msg("e", "heartbeat")]);
	assert.equal(typeSummary(d), "question, 2× worker_done, status");
});

test("formatDelivery lists actionable messages, counts heartbeats and names the ack", () => {
	const d = delivery([msg("hb", "heartbeat"), msg("q1", "question", { body: "Which branch?" }), msg("w1", "worker_done", { payload: '{"outcome":"succeeded"}', priority: "high" })]);
	const text = formatDelivery(d, { rawPath: "/tmp/raw.json" });
	assert.match(text, /^Orca delivery delivery_9 · run run_t · 2 messages · \+1 heartbeat/);
	assert.match(text, /1\. question from term_worker · id q1/);
	assert.match(text, /Which branch\?/);
	assert.match(text, /orca orchestration reply --id q1/);
	assert.match(text, /2\. worker_done \[HIGH\]/);
	assert.match(text, /orca_ack with deliveryId "delivery_9"/);
	assert.match(text, /Raw batch: \/tmp\/raw.json/);
	assert.doesNotMatch(text, /id hb/);
});

test("formatDelivery flags replays, bounds bodies and redacts secrets", () => {
	const d = delivery([msg("s1", "status", { body: `token=abcd1234secret ${"x".repeat(5000)}` })], true);
	const text = formatDelivery(d, { bodyMax: 200, note: "REPLAY: seen before" });
	assert.match(text, /REPLAY/);
	assert.match(text, /REPLAY: seen before/);
	assert.doesNotMatch(text, /abcd1234secret/);
	assert.match(text, /more chars\]/);
	assert.ok(text.length < 2000);
});

test("formatDelivery strips terminal escape sequences from bodies", () => {
	const text = formatDelivery(delivery([msg("s1", "status", { body: "\u001b[31mred\u001b[0m \u001b]0;title\u0007done" })]));
	assert.match(text, /red done/);
	assert.doesNotMatch(text, /\u001b/);
});
