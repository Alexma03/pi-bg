import { test } from "node:test";
import assert from "node:assert/strict";
import { checkArgs, extractJson, parseCheckOutput, parseRunCurrentOutput, type CliCapture } from "../lib/orca/cli.ts";

const cap = (stdout: string, extra: Partial<CliCapture> = {}): CliCapture => ({ stdout, stderr: "", exitCode: 0, signal: null, ...extra });

const deliveryDoc = {
	id: "req",
	ok: true,
	result: {
		runId: "run_test",
		deliveryId: "delivery_1",
		messages: [
			{ id: "msg_1", type: "heartbeat", from_handle: "term_a", to_handle: "run:run_test", subject: "hb", body: "", payload: null },
			{ id: "msg_2", type: "worker_done", from_handle: "term_b", to_handle: "run:run_test", subject: "done", body: "All good", payload: '{"outcome":"succeeded"}', priority: "normal" },
		],
		count: 2,
		replayed: false,
		acknowledged: null,
		timedOut: false,
		cancelled: false,
		connectionLost: false,
	},
};

test("extractJson ignores keepalive lines and trailing noise", () => {
	const text = `{"_keepalive":true}\n${JSON.stringify(deliveryDoc, null, 2)}\ntrailing`;
	const doc = extractJson(text) as { ok: boolean };
	assert.equal(doc.ok, true);
	assert.equal(extractJson(""), undefined);
	assert.equal(extractJson("not json"), undefined);
});

test("parseCheckOutput returns a delivery with parsed messages", () => {
	const out = parseCheckOutput(cap(JSON.stringify(deliveryDoc)));
	assert.equal(out.kind, "delivery");
	if (out.kind !== "delivery") return;
	assert.equal(out.delivery.id, "delivery_1");
	assert.equal(out.delivery.runId, "run_test");
	assert.equal(out.delivery.messages.length, 2);
	assert.equal(out.delivery.messages[1].from, "term_b");
	assert.equal(out.delivery.messages[1].payload, '{"outcome":"succeeded"}');
	assert.equal(out.acknowledged, null);
});

test("parseCheckOutput maps timeouts and acks", () => {
	const doc = { ok: true, result: { runId: "run_test", deliveryId: null, messages: [], count: 0, acknowledged: "delivery_0", timedOut: true } };
	const out = parseCheckOutput(cap(JSON.stringify(doc)));
	assert.deepEqual(out, { kind: "empty", acknowledged: "delivery_0", timedOut: true, cancelled: false, connectionLost: false });
});

test("parseCheckOutput maps Orca errors, transport failures and spawn errors", () => {
	const err = parseCheckOutput(cap(JSON.stringify({ ok: false, error: { code: "waiter_exists", message: "Run already has a waiter" } }), { exitCode: 1 }));
	assert.deepEqual(err, { kind: "error", code: "waiter_exists", message: "Run already has a waiter" });
	const transport = parseCheckOutput(cap("", { stderr: "connect ECONNREFUSED", exitCode: 1 }));
	assert.equal(transport.kind, "error");
	if (transport.kind === "error") {
		assert.equal(transport.code, "transport");
		assert.match(transport.message, /ECONNREFUSED/);
	}
	const spawn = parseCheckOutput(cap("", { spawnError: "orca not found on PATH", exitCode: null }));
	assert.deepEqual(spawn, { kind: "error", code: "spawn", message: "orca not found on PATH" });
});

test("parseRunCurrentOutput reads the bound Run or null", () => {
	assert.deepEqual(parseRunCurrentOutput(cap(JSON.stringify({ ok: true, result: { run: null } }))), { kind: "run", runId: null });
	assert.deepEqual(parseRunCurrentOutput(cap(JSON.stringify({ ok: true, result: { run: { id: "run_abc", objective: "x" } } }))), { kind: "run", runId: "run_abc" });
});

test("checkArgs never passes --types and orders ack before wait", () => {
	assert.deepEqual(checkArgs({ wait: true, ack: "d1", timeoutMs: 1000 }), ["orchestration", "check", "--ack", "d1", "--wait", "--timeout-ms", "1000", "--json"]);
	assert.deepEqual(checkArgs({ wait: false, ack: "d1" }), ["orchestration", "check", "--ack", "d1", "--json"]);
	assert.deepEqual(checkArgs({ wait: true, runId: "run_x" }).slice(0, 4), ["orchestration", "check", "--run", "run_x"]);
	assert.ok(!checkArgs({ wait: true }).includes("--types"));
});

test("waitInterrupted success documents become errors that remember the ack", () => {
	const doc = { ok: true, result: { runId: "r", deliveryId: null, messages: [], acknowledged: "d1", timedOut: false, cancelled: false, connectionLost: false, waitInterrupted: "consumer_fenced" } };
	assert.deepEqual(parseCheckOutput(cap(JSON.stringify(doc))), { kind: "error", code: "consumer_fenced", message: "wait refused after ack (consumer_fenced)", acknowledged: "d1" });
});
