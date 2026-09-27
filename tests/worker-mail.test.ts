import { test } from "node:test";
import assert from "node:assert/strict";
import { attachable, attachCommand, decideMail, formatMailNotice, initialMail, MAIL_REMIND_MS, parsePeek } from "../lib/orca/worker-mail.ts";
import { lastActivity } from "../lib/orca/activity.ts";

const msg = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "status", from_handle: "term_coord", subject: `s ${id}`, body: `b ${id}`, ...extra });

test("peek: keeps coordinator mail, drops heartbeats and the worker's own messages", () => {
	const got = parsePeek({ messages: [msg("m1"), msg("m2", { type: "heartbeat" }), msg("m3", { from_handle: "term_me" }), { nope: 1 }] }, "term_me");
	assert.deepEqual(got.map((m) => m.id), ["m1"]);
	assert.deepEqual(parsePeek(undefined, "x"), []);
});

test("mail: announce new messages once, remind after 5 min at most twice, forget read ones", () => {
	const m1 = { id: "m1", from: "c", type: "status", subject: "", body: "" };
	const m2 = { ...m1, id: "m2" };
	let d = decideMail(initialMail(), [m1], 0);
	assert.deepEqual(d.announce.map((m) => m.id), ["m1"]);
	d = decideMail(d.state, [m1], 60_000);
	assert.equal(d.announce.length, 0);
	d = decideMail(d.state, [m1, m2], 90_000);
	assert.deepEqual(d.announce.map((m) => m.id), ["m2"], "only the new one");
	d = decideMail(d.state, [m1, m2], 90_000 + MAIL_REMIND_MS);
	assert.equal(d.reminder, true);
	assert.deepEqual(d.announce.map((m) => m.id), ["m1", "m2"]);
	d = decideMail(d.state, [m1, m2], 90_000 + 2 * MAIL_REMIND_MS);
	assert.equal(d.reminder, true);
	d = decideMail(d.state, [m1, m2], 90_000 + 3 * MAIL_REMIND_MS);
	assert.equal(d.announce.length, 0, "reminder budget spent");
	d = decideMail(d.state, [], 90_000 + 4 * MAIL_REMIND_MS);
	assert.equal(d.state.announced.size, 0, "read messages are forgotten");
});

test("mail notice: lists messages, detached commands and the check to run; redacts", () => {
	const text = formatMailNotice([{ id: "m1", from: "c", type: "question", subject: "¿Seguimos?", body: "token=supersecret123456 y responde" }], { taskId: "task_a", dispatchId: "ctx_a", workerHandle: "term_w" }, { detached: [{ id: "bg2", command: "pnpm test" }] });
	assert.match(text, /question: ¿Seguimos\?/);
	assert.doesNotMatch(text, /supersecret123456/);
	assert.match(text, /`pnpm test` was moved to the background as bg2/);
	assert.match(text, /check --terminal term_w --json/);
});

test("attach: orca lifecycle commands stay in the foreground; the wrapper is quoted", () => {
	assert.equal(attachable("pnpm test"), true);
	assert.equal(attachable("orca orchestration send --type worker_done"), false);
	assert.equal(attachable("cd x && orca orchestration send --terminal t"), false);
	assert.equal(attachable("echo orcas are big"), true);
	assert.equal(attachable("   "), false);
	assert.equal(attachCommand("/usr/bin/node", "/a b/c.mjs", "/l'og", 42, "bg3"), "exec '/usr/bin/node' '/a b/c.mjs' '/l'\\''og' 42 bg3");
});

test("activity: an attached foreground command in the worker card is not 'waiting on background'", () => {
	const tail = ["$ # pi-bg bg4 (moves to the background if your coordinator writes): pnpm test", "╭─ ⏵ Segundo plano · 1 en marcha ──╮", "│ $ comando en curso · pnpm test · 2m05s · ok 12/40 │", "╰──────────────────────────────────╯"];
	assert.equal(lastActivity(tail), "$ pnpm test · 2m05s · ok 12/40");
	assert.equal(lastActivity(["│ $ bg4 bash · pnpm test · 2m05s │"]), "$ pnpm test · 2m05s", "old card format");
	assert.equal(lastActivity(["$ # pi-bg bg4 (moves to the background if your coordinator writes): pnpm lint", "ok"]), "$ pnpm lint");
});
