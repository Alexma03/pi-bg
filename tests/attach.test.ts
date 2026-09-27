// Real-process tests for attached tasks and the attach client.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskManager } from "../lib/tasks/manager.ts";
import type { TaskNotice } from "../lib/tasks/notice.ts";

const CLIENT = fileURLToPath(new URL("../lib/tasks/attach-client.mjs", import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function makeManager() {
	const notices: TaskNotice[] = [];
	const dir = await mkdtemp(join(tmpdir(), "pi-bg-attach-"));
	const manager = new TaskManager({ logDir: dir, now: Date.now, onNotice: (n) => notices.push(n), killGraceMs: 500 });
	return { manager, notices };
}

function runClient(logPath: string, offset: number, id: string): Promise<{ code: number | null; out: string; ms: number }> {
	const started = Date.now();
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [CLIENT, logPath, String(offset), id], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		child.on("close", (code) => resolve({ code, out, ms: Date.now() - started }));
	});
}

test("attached: the client streams the output (no header) and returns the exit code; no notice", async () => {
	const { manager, notices } = await makeManager();
	const snap = await manager.start({ command: "echo uno; sleep 0.3; echo dos; exit 3", cwd: tmpdir(), attached: true });
	const r = await runClient(snap.logPath, snap.outputOffset, snap.id);
	assert.equal(r.code, 3);
	assert.equal(r.out, "uno\ndos\n");
	await sleep(100);
	assert.equal(notices.length, 0, "an attached task reports through its client, not a notice");
	assert.equal(manager.get(snap.id)?.status, "exited");
});

test("detach: the client returns at once, the command keeps running and its notice follows", async () => {
	const { manager, notices } = await makeManager();
	const snap = await manager.start({ command: "echo start; sleep 1.2; echo fin", cwd: tmpdir(), attached: true });
	const client = runClient(snap.logPath, snap.outputOffset, snap.id);
	await sleep(300);
	assert.ok(manager.detach(snap.id));
	const r = await client;
	assert.equal(r.code, 0);
	assert.ok(r.ms < 1_000, `client returned after ${r.ms} ms`);
	assert.match(r.out, /^start\n/);
	assert.match(r.out, new RegExp(`Moved to the background as ${snap.id}`));
	assert.equal(manager.get(snap.id)?.status, "running");
	for (let i = 0; i < 60 && !notices.length; i++) await sleep(50);
	assert.equal(notices.length, 1);
	assert.equal(notices[0].kind, "exit");
	assert.deepEqual(notices[0].lines, ["start", "fin"]);
	assert.equal(manager.detach(snap.id), undefined, "a finished task cannot be detached");
});

test("cancel while attached: the client exits non-zero", async () => {
	const { manager } = await makeManager();
	const snap = await manager.start({ command: "sleep 30", cwd: tmpdir(), attached: true });
	const client = runClient(snap.logPath, snap.outputOffset, snap.id);
	await sleep(200);
	manager.cancel(snap.id);
	const r = await client;
	assert.notEqual(r.code, 0);
});
