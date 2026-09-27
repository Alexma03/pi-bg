// Real-process tests for the task manager and the spawn watchdog (bash only).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
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

test("a backgrounded child does not outlive its task", async () => {
	const { manager, notices, dir } = await makeManager();
	const pidFile = join(dir, "orphan.pid");
	await manager.start({ command: `sleep 300 >/dev/null 2>&1 & echo $! > ${pidFile}; exit 4`, cwd: tmpdir() });
	await until(() => notices.length === 1);
	assert.equal(notices[0].exitCode, 4);
	const orphan = Number((await readFile(pidFile, "utf8")).trim());
	await until(() => !alive(orphan), 3_000);
});

test("a TERM-ignoring leftover is killed after the task exits", async () => {
	const { manager, notices, dir } = await makeManager();
	const pidFile = join(dir, "stubborn.pid");
	// The inner shell records its pid only after installing the trap; the task waits for it.
	await manager.start({ command: `bash -c "trap '' TERM; echo \\$\\$ > ${pidFile}; exec sleep 300" >/dev/null 2>&1 & until [ -s ${pidFile} ]; do sleep 0.05; done`, cwd: tmpdir() });
	await until(() => notices.length === 1);
	assert.equal(notices[0].exitCode, 0);
	const stubborn = Number((await readFile(pidFile, "utf8")).trim());
	await until(() => !alive(stubborn), 4_000);
});

test("tail and exit notice redact a multiline PEM key", async () => {
	const { manager, notices } = await makeManager();
	const key = "printf '%s\\n' '-----BEGIN PRIVATE KEY-----' MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun '-----END PRIVATE KEY-----' done";
	const task = await manager.start({ command: key, cwd: tmpdir() });
	await until(() => notices.length === 1);
	assert.ok(!notices[0].lines.join("\n").includes("MIIEow"), notices[0].lines.join("\n"));
	const full = await manager.tail(task.id);
	assert.ok(!full.includes("MIIEow"), full);
	assert.match(full, /done$/);
	// A small in-memory tail cuts the BEGIN line: the body line is still hidden.
	const cutNotices: TaskNotice[] = [];
	const small = new TaskManager({ logDir: await mkdtemp(join(tmpdir(), "pi-bg-test-")), now: Date.now, onNotice: (n) => cutNotices.push(n), tailChars: 100 });
	await small.start({ command: key, cwd: tmpdir() });
	await until(() => cutNotices.length === 1);
	const cut = cutNotices[0].lines.join("\n");
	assert.ok(!cut.includes("BEGIN") && !cut.includes("MIIEow"), cut);
	assert.match(cut, /done$/);
});

test("an unopenable log file is reported instead of crashing", async () => {
	const notices: TaskNotice[] = [];
	const dir = await mkdtemp(join(tmpdir(), "pi-bg-test-"));
	const now = () => 1_700_000_000_000;
	const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
	await mkdir(join(dir, `${stamp}-bg1.log`));
	const manager = new TaskManager({ logDir: dir, now, onNotice: (n) => notices.push(n), killGraceMs: 500 });
	const task = await manager.start({ command: "echo still-here; sleep 0.3", cwd: tmpdir() });
	await until(() => notices.length === 1);
	assert.match(manager.get(task.id)?.logError ?? "", /EISDIR|directory/i);
	assert.match(notices[0].note ?? "", /log file could not be written/);
	assert.deepEqual(notices[0].lines, ["still-here"]);
	assert.match(await manager.tail(task.id), /still-here/);
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

test("parallel starts cannot exceed the running limit", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-bg-test-"));
	const manager = new TaskManager({ logDir: dir, now: Date.now, onNotice: () => {}, maxRunning: 2, killGraceMs: 200 });
	const results = await Promise.allSettled([1, 2, 3, 4].map(() => manager.start({ command: "sleep 30", cwd: tmpdir() })));
	assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
	await manager.shutdown(300);
});

test("the watchdog also kills TERM-ignoring children when the parent dies", async () => {
	const fakeParent = spawn("sleep", ["0.5"]);
	const dir = await mkdtemp(join(tmpdir(), "pi-bg-test-"));
	const pidFile = join(dir, "pid");
	const child = spawnGroup(["bash", "-c", `trap '' TERM; sleep 60 & echo $! > ${pidFile}; wait`], { cwd: tmpdir(), parentPid: fakeParent.pid });
	await until(() => {
		try {
			return require_nonempty(pidFile);
		} catch {
			return false;
		}
	});
	const sleeper = Number((await readFile(pidFile, "utf8")).trim());
	await until(() => !alive(sleeper), 12_000);
	killGroup(child.pid, "SIGKILL");
});
