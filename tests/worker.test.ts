import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptedByOrca, initialWorker, MAX_REMINDERS, onInput, onLifecycleResult, parsePreamble, REMINDER_GAP_MS, reminderFor } from "../lib/orca/worker.ts";

const PREAMBLE = `You are a supervised Orca worker.
  orca orchestration send --from term_abc-123 --type escalation --subject "Blocked: <reason>" --body "<details>" --task-id task_58a5a2948f01 --dispatch-id ctx_d150ee4291e9
  orca orchestration check --terminal term_abc-123 --json

=== TASK ===
Read-only smoke test.`;
const DONE = "orca orchestration send --type worker_done --task-id task_58a5a2948f01 --dispatch-id ctx_d150ee4291e9";
const settle = (now: number, extra: Partial<{ outcome: string; busy: boolean }> = {}) => ({ outcome: "completed", now, busy: false, ...extra });

test("parses the Orca worker preamble", () => {
	assert.deepEqual(parsePreamble(PREAMBLE), { taskId: "task_58a5a2948f01", dispatchId: "ctx_d150ee4291e9", workerHandle: "term_abc-123" });
	assert.equal(parsePreamble("please run --dispatch-id ctx_1 --task-id task_1"), undefined);
	assert.equal(parsePreamble("=== TASK === without ids"), undefined);
});

test("reminders are rate-limited and capped, and reset on new input", () => {
	let s = onInput(initialWorker(), PREAMBLE);
	let r = reminderFor(s, settle(0));
	assert.match(r.text ?? "", /ctx_d150ee4291e9/);
	s = r.state;
	assert.equal(reminderFor(s, settle(REMINDER_GAP_MS - 1)).text, undefined, "too soon");
	r = reminderFor(s, settle(REMINDER_GAP_MS));
	assert.ok(r.text);
	s = r.state;
	assert.equal(s.reminders, MAX_REMINDERS);
	assert.equal(reminderFor(s, settle(10 * REMINDER_GAP_MS)).text, undefined, "capped");
	s = onInput(s, "coordinator follow-up: please also check X");
	assert.ok(reminderFor(s, settle(11 * REMINDER_GAP_MS)).text, "new input resets the budget");
});

test("no reminder while busy, on aborted turns, after an accepted worker_done, or outside a dispatch", () => {
	assert.equal(reminderFor(initialWorker(), settle(0)).text, undefined);
	let s = onInput(initialWorker(), PREAMBLE);
	assert.equal(reminderFor(s, settle(0, { busy: true })).text, undefined);
	assert.equal(reminderFor(s, settle(0, { outcome: "aborted" })).text, undefined);
	// A rejected send does not count.
	s = onLifecycleResult(s, ["worker-done"], DONE, acceptedByOrca('{"ok": false, "error": {}}', false));
	assert.equal(s.doneSent, false);
	s = onLifecycleResult(s, ["worker-done"], DONE, acceptedByOrca('{\n  "ok": true\n}', false));
	assert.equal(s.doneSent, true);
	assert.equal(reminderFor(s, settle(0)).text, undefined);
});

test("a worker_done for another dispatch does not count; a new preamble resets", () => {
	let s = onInput(initialWorker(), PREAMBLE);
	s = onLifecycleResult(s, ["worker-done"], "orca orchestration send --type worker_done --task-id task_other --dispatch-id ctx_other", true);
	assert.equal(s.doneSent, false);
	s = onLifecycleResult(s, ["worker-done"], DONE, true);
	const next = onInput(s, PREAMBLE.replace("ctx_d150ee4291e9", "ctx_second").replace("task_58a5a2948f01", "task_second"));
	assert.equal(next.identity?.dispatchId, "ctx_second");
	assert.equal(next.doneSent, false);
	assert.equal(onInput(s, PREAMBLE).doneSent, true, "the same preamble again keeps state");
});
