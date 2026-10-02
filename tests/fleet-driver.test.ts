// FleetWatch against the fake orca CLI (never the real Orca app).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FleetWatch } from "../lib/orca/fleet-driver.ts";
import type { FleetEvent } from "../lib/orca/fleet.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-orca.sh", import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const worker = (id: string, activity: string, observedAt: number) => ({
	dispatchId: id,
	taskId: `task_${id}`,
	runId: "run_fake",
	workerState: "ready",
	dispatchStatus: "dispatched",
	terminalState: "active",
	agentTerminalHandle: `term_${id}`,
	resource: { ownershipState: "owned" },
	projection: { stage: { activity }, outcome: "in_progress", liveness: { verdict: "live", observedAt }, attention: { categories: [], requiresAction: false }, nextAction: { kind: "none" } },
});

test("switching the bridge off and on for the same Run does not report open workers again", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-bg-fleet-"));
	await chmod(FAKE, 0o755);
	await writeFile(join(dir, "calls.log"), "");
	await writeFile(join(dir, "workers.json"), JSON.stringify({ ok: true, result: { workers: [worker("ctx_a", "done", Date.now() - 10 * 60_000)], page: { hasMore: false, nextCursor: null } } }));
	await writeFile(join(dir, "tasks.json"), JSON.stringify({ ok: true, result: { tasks: [] } }));
	const got: FleetEvent[][] = [];
	const fleet = new FleetWatch({ orcaBin: FAKE, cwd: dir, env: { ...process.env, FAKE_ORCA_DIR: dir }, now: Date.now, onEvents: (e) => got.push(e), onChange: () => {}, pollMs: 60_000, activityMs: 0, watchdogPath: join(dir, "watchdog.json") });
	try {
		fleet.watch("run_fake");
		for (let i = 0; i < 100 && got.length === 0; i++) await sleep(20);
		assert.ok(got.flat().some((e) => e.kind === "stalled"));
		fleet.stop();
		fleet.watch("run_fake");
		await fleet.poll();
		assert.equal(got.flat().filter((e) => e.kind === "stalled").length, 1, "reported once across off/on");
	} finally {
		fleet.dispose();
	}
});

test("the release notice honours the watchdog's releaseGraceMinutes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-bg-fleet-"));
	await chmod(FAKE, 0o755);
	await writeFile(join(dir, "calls.log"), "");
	await writeFile(join(dir, "tasks.json"), JSON.stringify({ ok: true, result: { tasks: [] } }));
	const rows = (w: unknown) => writeFile(join(dir, "workers.json"), JSON.stringify({ ok: true, result: { workers: [w], page: { hasMore: false, nextCursor: null } } }));
	let clock = Date.now();
	const got: FleetEvent[] = [];
	const fleet = new FleetWatch({ orcaBin: FAKE, cwd: dir, env: { ...process.env, FAKE_ORCA_DIR: dir }, now: () => clock, onEvents: (e) => got.push(...e), onChange: () => {}, pollMs: 600_000, activityMs: 0, watchdogPath: join(dir, "watchdog.json"), watchdogConfig: { releaseGraceMs: 60_000 } });
	try {
		await rows(worker("ctx_a", "working", clock));
		fleet.watch("run_fake");
		await fleet.poll();
		const done = worker("ctx_a", "done", clock);
		await rows({ ...done, workerState: "succeeded", projection: { ...done.projection, outcome: "succeeded", nextAction: { kind: "release" } } });
		await fleet.poll();
		clock += 2 * 60_000;
		await fleet.poll();
		assert.ok(got.some((e) => e.kind === "release" && e.dispatchId === "ctx_a"), "2 min > the configured 1 min grace");
	} finally {
		fleet.dispose();
	}
});

test("polls read-only, reports a stalled worker with its task title, and pages explicitly", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-bg-fleet-"));
	await chmod(FAKE, 0o755);
	await writeFile(join(dir, "calls.log"), "");
	const tenMinAgo = Date.now() - 10 * 60_000;
	await writeFile(join(dir, "workers.json"), JSON.stringify({ ok: true, result: { workers: [worker("ctx_a", "done", tenMinAgo), worker("ctx_b", "working", Date.now())], page: { hasMore: false, nextCursor: null } } }));
	await writeFile(join(dir, "tasks.json"), JSON.stringify({ ok: true, result: { tasks: [{ id: "task_ctx_a", display_name: "funds-a0", status: "dispatched", deps: "[]" }] } }));
	const got: FleetEvent[][] = [];
	const fleet = new FleetWatch({ orcaBin: FAKE, cwd: dir, env: { ...process.env, FAKE_ORCA_DIR: dir }, now: Date.now, onEvents: (e) => got.push(e), onChange: () => {}, pollMs: 60_000 });
	try {
		fleet.watch("run_fake");
		for (let i = 0; i < 100 && got.length === 0; i++) await sleep(20);
		assert.equal(got.length, 1);
		const stalled = got[0].find((e) => e.kind === "stalled");
		assert.equal(stalled?.dispatchId, "ctx_a");
		assert.equal(stalled?.title, "funds-a0");
		const calls = (await readFile(join(dir, "calls.log"), "utf8")).trim().split("\n");
		assert.ok(calls.includes("orchestration worker-list --run run_fake --limit 100 --json"));
		assert.ok(calls.includes("orchestration task-list --run run_fake --json"));
		assert.ok(calls.every((c) => !c.includes(" check")), "fleet watch never touches the mailbox");
	} finally {
		fleet.dispose();
	}
});

test("native watchdog compares committed worker changes against the Task's allowed surfaces", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-bg-watchdog-worktree-"));
	const state = await mkdtemp(join(tmpdir(), "pi-bg-watchdog-state-"));
	const dir = await mkdtemp(join(tmpdir(), "pi-bg-watchdog-orca-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
	await chmod(FAKE, 0o755);
	await writeFile(join(dir, "calls.log"), "");
	try {
		git("init", "-b", "main");
		await writeFile(join(root, "src.ts"), "base\n");
		git("add", "src.ts");
		git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base");
		git("branch", "origin/main");
		git("checkout", "-b", "feat/worker");
		await writeFile(join(root, "docs-private.md"), "outside scope\n");
		git("add", "docs-private.md");
		git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "outside scope");
		const row = { ...worker("ctx_scope", "working", Date.now()), workspacePath: root };
		await writeFile(join(dir, "workers.json"), JSON.stringify({ ok: true, result: { workers: [row], page: { hasMore: false, nextCursor: null } } }));
		await writeFile(join(dir, "tasks.json"), JSON.stringify({ ok: true, result: { tasks: [{ id: "task_ctx_scope", display_name: "scoped worker", spec: "Allowed edit surfaces:\n- `src/**`", status: "dispatched", deps: "[]" }] } }));
		await writeFile(join(dir, "worker-read.json"), JSON.stringify({ ok: true, result: { terminal: { tail: ["Working on the implementation"] } } }));
		const events: FleetEvent[] = [];
		const fleet = new FleetWatch({ orcaBin: FAKE, cwd: dir, env: { ...process.env, FAKE_ORCA_DIR: dir }, now: Date.now, onEvents: (e) => events.push(...e), onChange: () => {}, activityMs: 0, watchdogPath: join(state, "orca", "watchdog.json") });
		try {
			fleet.watch("run_fake");
			for (let i = 0; i < 100 && !fleet.worker("ctx_scope"); i++) await sleep(20);
			assert.ok(fleet.worker("ctx_scope"), "worker inventory loaded");
			await fleet.readActivity();
			const finding = events.find((event) => event.kind === "scope");
			assert.ok(finding, events.map((event) => `${event.kind}:${event.detail}`).join("\n"));
			assert.match(finding.detail ?? "", /docs-private\.md/);
			const saved = JSON.parse(await readFile(join(state, "orca", "watchdog-run_fake.json"), "utf8"));
			assert.ok(saved.state.active.some((key: string) => key.startsWith("scope:ctx_scope:")));
			assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), "", "watchdog scans do not write to the worker worktree");
		} finally {
			fleet.dispose();
		}
	} finally {
		await Promise.all([rm(root, { recursive: true, force: true }), rm(state, { recursive: true, force: true }), rm(dir, { recursive: true, force: true })]);
	}
});

test("two coordinators on different Runs keep their own watchdog state and label", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-bg-fleet-"));
	await chmod(FAKE, 0o755);
	await writeFile(join(dir, "calls.log"), "");
	await writeFile(join(dir, "workers.json"), JSON.stringify({ ok: true, result: { workers: [], page: { hasMore: false, nextCursor: null } } }));
	await writeFile(join(dir, "tasks.json"), JSON.stringify({ ok: true, result: { tasks: [] } }));
	const path = join(dir, "state", "watchdog.json");
	const make = () => new FleetWatch({ orcaBin: FAKE, cwd: dir, env: { ...process.env, FAKE_ORCA_DIR: dir }, now: Date.now, onEvents: () => {}, onChange: () => {}, pollMs: 600_000, activityMs: 0, watchdogPath: path });
	const a = make();
	const b = make();
	try {
		a.watch("run_aaa");
		b.watch("run_bbb");
		await Promise.all([a.setLabel("label A"), b.setLabel("label B")]);
	} finally {
		a.dispose();
		b.dispose();
	}
	for (const [runId, label] of [["run_aaa", "label A"], ["run_bbb", "label B"]]) {
		const reload = make();
		try {
			reload.watch(runId);
			await reload.configureWatchdog({});
			assert.equal(reload.label, label, `${runId} kept its own label`);
		} finally {
			reload.dispose();
		}
	}
});

test("a watchdog setting made while the state file is still loading is kept", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-bg-fleet-"));
	await chmod(FAKE, 0o755);
	await writeFile(join(dir, "calls.log"), "");
	await writeFile(join(dir, "workers.json"), JSON.stringify({ ok: true, result: { workers: [], page: { hasMore: false, nextCursor: null } } }));
	await writeFile(join(dir, "tasks.json"), JSON.stringify({ ok: true, result: { tasks: [] } }));
	const path = join(dir, "watchdog.json");
	await writeFile(path, JSON.stringify({ version: 1, config: { stallMs: 20 * 60_000 } }));
	const fleet = new FleetWatch({ orcaBin: FAKE, cwd: dir, env: { ...process.env, FAKE_ORCA_DIR: dir }, now: Date.now, onEvents: () => {}, onChange: () => {}, pollMs: 600_000, activityMs: 0, watchdogPath: path });
	try {
		fleet.watch("run_fake");
		const set = await fleet.configureWatchdog({ stallMs: 7 * 60_000 });
		assert.equal(set.stallMs, 7 * 60_000);
		await sleep(100);
		assert.equal(fleet.watchdog.stallMs, 7 * 60_000, "the earlier file contents did not overwrite the new setting");
	} finally {
		fleet.dispose();
	}
});
