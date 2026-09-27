// FleetWatch against the fake orca CLI (never the real Orca app).

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
