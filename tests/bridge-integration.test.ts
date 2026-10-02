// Drives the real OrcaBridge (processes, timers, parsing) against a fake
// orca CLI. Never talks to the real Orca app.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OrcaBridge } from "../lib/orca/bridge.ts";
import type { Delivery } from "../lib/orca/delivery.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-orca.sh", import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error("timed out waiting for condition");
		await sleep(25);
	}
}

let seq = 0;
async function enqueue(dir: string, doc: unknown): Promise<void> {
	await writeFile(join(dir, "queue", `${String(++seq).padStart(4, "0")}.json`), JSON.stringify(doc));
}

const delivery = (id: string, types: string[], extra: Record<string, unknown> = {}) => ({
	ok: true,
	result: {
		runId: "run_fake",
		deliveryId: id,
		messages: types.map((type, i) => ({ id: `${id}_m${i}`, type, from_handle: "term_w", to_handle: "run:run_fake", subject: `${type} ${i}`, body: `body ${i}`, payload: null })),
		count: types.length,
		replayed: false,
		acknowledged: null,
		timedOut: false,
		...extra,
	},
});

async function setup(onChange: (bridge: OrcaBridge) => void = () => {}) {
	const dir = await mkdtemp(join(tmpdir(), "pi-bg-orca-"));
	await mkdir(join(dir, "queue"));
	await writeFile(join(dir, "run.json"), JSON.stringify({ ok: true, result: { run: { id: "run_fake" } } }));
	await writeFile(join(dir, "calls.log"), "");
	await chmod(FAKE, 0o755);
	const injected: Array<{ delivery: Delivery; note?: string }> = [];
	const bridge = new OrcaBridge({
		orcaBin: FAKE,
		cwd: dir,
		env: { ...process.env, FAKE_ORCA_DIR: dir },
		rawDir: join(dir, "raw"),
		now: Date.now,
		inject: (d, note) => injected.push({ delivery: d, note }),
		remind: () => {},
		onChange: () => onChange(bridge),
	});
	const calls = async () => (await readFile(join(dir, "calls.log"), "utf8")).trim().split("\n").filter(Boolean);
	return { dir, bridge, injected, calls };
}

test("full cycle: detect, heartbeat auto-ack, inject, orca_ack, re-arm", async () => {
	const { dir, bridge, injected, calls } = await setup();
	try {
		await enqueue(dir, delivery("d_hb", ["heartbeat", "heartbeat"]));
		await enqueue(dir, delivery("d_work", ["heartbeat", "worker_done"]));
		bridge.start();
		await until(() => injected.length === 1);
		assert.equal(injected[0].delivery.id, "d_work");
		assert.equal(bridge.state.phase, "pending");
		assert.equal(bridge.state.heartbeatsAcked, 2);

		const log = await calls();
		assert.equal(log[0], "orchestration run-current --json");
		assert.ok(log.every((line) => !line.includes("--types")), "waiter must not filter types");
		assert.ok(log.some((line) => line.includes("--ack d_hb --wait")), "heartbeat batch acked on the next wait");

		// No waiter while pending: the outstanding delivery holds the mailbox.
		const before = (await calls()).length;
		await sleep(300);
		assert.equal((await calls()).length, before);

		const reply = await bridge.ack("d_work");
		assert.equal(reply.ok, true, reply.text);
		await until(async () => (await calls()).some((line) => line === "orchestration check --ack d_work --json"));
		await until(() => bridge.state.phase === "waiting");
	} finally {
		bridge.dispose();
	}
});

test("orca_ack returns a queued next batch inline", async () => {
	const { dir, bridge, injected } = await setup();
	try {
		await enqueue(dir, delivery("d1", ["status"]));
		bridge.start();
		await until(() => injected.length === 1);
		await enqueue(dir, delivery("d2", ["question"], { acknowledged: "d1" }));
		const reply = await bridge.ack("d1");
		assert.equal(reply.ok, true);
		assert.equal(reply.next?.id, "d2");
		assert.equal(bridge.state.phase, "pending");
		assert.equal(bridge.state.pending?.id, "d2");
		assert.equal(injected.length, 1, "inline next batch is not injected again");
	} finally {
		bridge.dispose();
	}
});

test("waiter_exists backs off and is visible in the state", async () => {
	const { dir, bridge } = await setup();
	try {
		await enqueue(dir, { ok: false, error: { code: "waiter_exists", message: "Run run_fake already has an active actionable waiter." } });
		bridge.start();
		await until(() => bridge.state.phase === "backoff");
		assert.equal(bridge.state.reason, "another waiter holds this Run");
		assert.ok((bridge.state.retryAt ?? 0) - Date.now() > 10_000);
	} finally {
		bridge.dispose();
	}
});

test("no bound Run leaves the bridge off", async () => {
	const { dir, bridge, calls } = await setup();
	try {
		await writeFile(join(dir, "run.json"), JSON.stringify({ ok: true, result: { run: null } }));
		bridge.start();
		await until(() => bridge.state.reason === "no Run bound");
		assert.equal(bridge.state.phase, "off");
		await sleep(200);
		assert.deepEqual(await calls(), ["orchestration run-current --json"]);
	} finally {
		bridge.dispose();
	}
});

test("dispose kills the waiter process", async () => {
	const { bridge, calls } = await setup();
	bridge.start();
	await until(async () => (await calls()).some((line) => line.includes("--wait")));
	bridge.dispose();
	await sleep(300);
	// The fake waiter would answer timedOut after 5 s; nothing may arrive after dispose.
	assert.equal(bridge.state.phase, "waiting");
});

test("a delivery dropped while its raw file is saved is not injected", async () => {
	let off = false;
	const { dir, bridge, injected } = await setup((b) => {
		// The inject effect has started saving; switch off before it lands.
		if (!off && b.state.phase === "pending") {
			off = true;
			b.turnOff();
		}
	});
	try {
		await enqueue(dir, delivery("d_late", ["worker_done"]));
		bridge.start();
		await until(() => off);
		await sleep(300);
		assert.equal(injected.length, 0, "no longer pending, so not shown to the model");
	} finally {
		bridge.dispose();
	}
});

test("orca_ack after dispose answers at once instead of hanging", async () => {
	const { bridge } = await setup();
	bridge.dispose();
	const reply = await Promise.race([bridge.ack("d_x"), sleep(500).then(() => undefined)]);
	assert.ok(reply, "ack resolved");
	assert.equal(reply.ok, false);
});
