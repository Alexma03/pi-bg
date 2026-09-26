// Real-process tests for the task manager and the spawn watchdog (bash only).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskManager } from "../lib/tasks/manager.ts";
import type { TaskNotice } from "../lib/tasks/notice.ts";
import { killGroup, spawnGroup } from "../lib/spawn.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for condition");
		await sleep(25);
	}
}

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function makeManager() {
	const notices: TaskNotice[] = [];
	const dir = await mkdtemp(join(tmpdir(), "pi-bg-test-"));
	const manager = new TaskManager({ logDir: dir, now: Date.now, onNotice: (n) => notices.push(n), killGraceMs: 500 });
	return { manager, notices, dir };
}

test("exit notice carries the exit code and last lines; log is written", async () => {
	const { manager, notices } = await makeManager();
	const task = await manager.start({ command: "echo one; echo two >&2; exit 3", cwd: tmpdir(), label: "demo" });
	await until(() => notices.length === 1);
	const n = notices[0];
	assert.equal(n.kind, "exit");
	assert.equal(n.exitCode, 3);
	assert.deepEqual(n.lines.slice(-2), ["one", "two"]);
	assert.equal(manager.get(task.id)?.status, "exited");
	const log = await readFile(task.logPath, "utf8");
	assert.match(log, /# \$ echo one/);
	assert.match(log, /one\ntwo/);
	assert.match(await manager.tail(task.id, { lines: 1 }), /two/);
});

test("watch until stops the task on the first match with one notice", async () => {
	const { manager, notices } = await makeManager();
	const task = await manager.start({ command: "for i in 1 2 3 4 5 6 7 8 9; do echo step $i; sleep 0.2; done; echo READY; sleep 30", cwd: tmpdir(), watch: { pattern: "READY" } });
	await until(() => manager.get(task.id)?.status !== "running" && manager.get(task.id)?.endedAt !== undefined);
	assert.equal(notices.length, 1);
	assert.equal(notices[0].kind, "match");
	assert.deepEqual(notices[0].lines, ["READY"]);
	assert.equal(notices[0].stillRunning, false);
	assert.equal(manager.get(task.id)?.status, "matched");
});

test("watch each coalesces matches and still reports the exit", async () => {
	const { manager, notices } = await makeManager();
	await manager.start({ command: "echo err a; echo err b; sleep 0.1; echo fine; exit 0", cwd: tmpdir(), watch: { pattern: "^err", mode: "each", coalesceMs: 50 } });
	await until(() => notices.some((n) => n.kind === "exit"));
	const matches = notices.filter((n) => n.kind === "match");
	assert.equal(matches.length, 1);
	assert.deepEqual(matches[0].lines, ["err a", "err b"]);
});

test("deadline stops the task and reports a timeout", async () => {
	const { manager, notices } = await makeManager();
	await manager.start({ command: "sleep 30", cwd: tmpdir(), timeoutMs: 300 });
	await until(() => notices.length === 1);
	assert.equal(notices[0].kind, "timeout");
});

test("cancel is quiet and kills grandchildren in the group", async () => {
	const { manager, notices, dir } = await makeManager();
	const pidFile = join(dir, "child.pid");
	const task = await manager.start({ command: `sleep 60 & echo $! > ${pidFile}; wait`, cwd: tmpdir() });
	await until(() => {
		try {
			return require_nonempty(pidFile);
		} catch {
			return false;
		}
	});
	const grandchild = Number((await readFile(pidFile, "utf8")).trim());
	assert.ok(alive(grandchild));
	assert.equal(manager.cancel(task.id), true);
	await until(() => manager.get(task.id)?.endedAt !== undefined);
	await until(() => !alive(grandchild));
	await sleep(100);
	assert.equal(notices.length, 0);
	assert.equal(manager.get(task.id)?.status, "cancelled");
});

test("shutdown kills every running task", async () => {
	const { manager, notices } = await makeManager();
	const a = await manager.start({ command: "sleep 60", cwd: tmpdir() });
	const b = await manager.start({ command: "trap '' TERM; sleep 60", cwd: tmpdir() });
	await sleep(100);
	await manager.shutdown(300);
	await until(() => !alive(a.pid!) && !alive(b.pid!));
	assert.equal(notices.length, 0);
});

test("the watchdog kills the group when the parent process dies", async () => {
	const fakeParent = spawn("sleep", ["0.5"]);
	const child = spawnGroup(["sleep", "60"], { cwd: tmpdir(), parentPid: fakeParent.pid });
	const pid = child.pid!;
	assert.ok(alive(pid));
	await until(() => !alive(pid), 10_000);
	killGroup(pid, "SIGKILL");
});

function require_nonempty(path: string): boolean {
	return statSync(path).size > 0;
}
