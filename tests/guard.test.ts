import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyOrcaCommand } from "../lib/orca/guard.ts";

test("consuming checks are detected in any shape", () => {
	for (const cmd of [
		"orca orchestration check --json",
		"orca orchestration check --ack delivery_1 --json",
		"orca orchestration check --wait --types worker_done --timeout-ms 900000 --json",
		"cd /x && orca orchestration check --run run_1",
		"/home/alex/.config/orca/linux-orca-cli-shim/orca orchestration check",
		"orca-wait --timeout-min 30",
		"echo hi; ~/.local/bin/orca-wait",
		"x=$(orca orchestration check --json)",
	]) {
		assert.ok(classifyOrcaCommand(cmd).includes("consuming-check"), cmd);
	}
});

test("read-only checks and other orca verbs are allowed", () => {
	assert.deepEqual(classifyOrcaCommand("orca orchestration check --peek --json"), ["peek-check"]);
	assert.deepEqual(classifyOrcaCommand("orca orchestration check --all --json"), ["peek-check"]);
	assert.deepEqual(classifyOrcaCommand("orca orchestration worker-list --json"), ["other"]);
	assert.deepEqual(classifyOrcaCommand("orca orchestration send --to run:r --body check"), ["other"]);
	assert.deepEqual(classifyOrcaCommand("grep 'orchestration check' AGENTS.md"), ["other"]);
});

test("run binding commands are detected", () => {
	assert.deepEqual(classifyOrcaCommand('orca orchestration run-create --objective "x" --json'), ["bind"]);
	assert.deepEqual(classifyOrcaCommand("orca orchestration run-use --run run_1"), ["bind"]);
});

test("lifecycle commands are classified for fleet and worker tracking", () => {
	assert.deepEqual(classifyOrcaCommand('orca orchestration worker-start --agent pi --spec "x" --json'), ["worker-start"]);
	assert.deepEqual(classifyOrcaCommand('orca orchestration send --from term_1 --type worker_done --subject "done" --body "ok" --task-id t --dispatch-id d'), ["worker-done"]);
	assert.deepEqual(classifyOrcaCommand('orca orchestration send --type escalation --subject "Blocked"'), ["escalation"]);
	assert.deepEqual(classifyOrcaCommand('orca orchestration ask --from term_1 --question "which?"'), ["ask"]);
	assert.deepEqual(classifyOrcaCommand('orca orchestration send --type status --subject "x"'), ["other"]);
});

test("--ack makes a peek or history check consuming", () => {
	assert.deepEqual(classifyOrcaCommand("orca orchestration check --ack d1 --peek --json"), ["consuming-check"]);
	assert.deepEqual(classifyOrcaCommand("orca orchestration check --all --ack=d1"), ["consuming-check"]);
});
