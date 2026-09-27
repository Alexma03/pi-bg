import { test } from "node:test";
import assert from "node:assert/strict";
import { deliveryView, messageFacts, workerOutcome } from "../lib/ui/delivery-view.ts";
import type { Delivery, OrcaMessage } from "../lib/orca/delivery.ts";

const m = (id: string, type: string, extra: Partial<OrcaMessage> = {}): OrcaMessage => ({ id, type, from: "term_w", to: "run:r", subject: `${type} s`, body: "body", payload: "", priority: "normal", threadId: "", createdAt: "", ...extra });

test("worker_done outcome comes from the payload", () => {
	assert.equal(workerOutcome(m("a", "worker_done", { payload: '{"outcome":"failed"}' })), "failed");
	assert.equal(workerOutcome(m("a", "status", { payload: '{"outcome":"failed"}' })), undefined);
});

test("collapsed view: one line per message, urgent tone, secrets redacted", () => {
	const d: Delivery = { id: "d1", runId: "r", replayed: true, messages: [m("h", "heartbeat"), m("q", "question", { subject: "token=abcd1234zz?" }), m("w", "worker_done", { payload: '{"outcome":"succeeded"}' })] };
	const view = deliveryView({ deliveryId: d.id, messages: messageFacts(d), heartbeats: 1, replay: true }, "", false);
	assert.match(view.title, /Orca · 2 messages · \+1 heartbeat · REPLAY · d1/);
	assert.equal(view.tone, "warning");
	assert.match(view.lines[0].text, /^\? question/);
	assert.doesNotMatch(view.lines[0].text, /abcd1234zz/);
	assert.match(view.lines[1].text, /^✔ worker_done succeeded/);
	assert.equal(view.lines[1].tone, "success");
	assert.ok(!view.lines.some((l) => l.text.startsWith("    body")));
	const expanded = deliveryView({ deliveryId: d.id, messages: messageFacts(d) }, "", true);
	assert.ok(expanded.lines.some((l) => l.text === "    body"));
});
