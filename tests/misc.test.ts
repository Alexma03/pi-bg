import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffDelay, TRANSPORT_BACKOFF } from "../lib/backoff.ts";
import { redact } from "../lib/redact.ts";
import { footerText } from "../lib/status.ts";
import { initialState } from "../lib/orca/machine.ts";
import { clip, formatDuration, lastLines, sanitizeTerminal } from "../lib/text.ts";
import { formatNotice, formatNotices, type TaskNotice } from "../lib/tasks/notice.ts";
import { LineSplitter, Watcher } from "../lib/tasks/watch.ts";

test("backoff grows, caps and jitters within bounds", () => {
	assert.equal(backoffDelay(TRANSPORT_BACKOFF, 0, () => 0.5), 1_000);
	assert.equal(backoffDelay(TRANSPORT_BACKOFF, 3, () => 0.5), 8_000);
	assert.equal(backoffDelay(TRANSPORT_BACKOFF, 50, () => 0.5), 60_000);
	const low = backoffDelay(TRANSPORT_BACKOFF, 2, () => 0);
	const high = backoffDelay(TRANSPORT_BACKOFF, 2, () => 0.999);
	assert.ok(low >= 3_200 && high <= 4_800, `${low} ${high}`);
});

test("redact removes common credential shapes", () => {
	const input = [
		"Authorization: Bearer abcdefghijklmnop",
		"export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123",
		'{"password": "hunter22"}',
		"postgres://user:s3cretpw@db:5432/x",
		"key AKIAABCDEFGHIJKLMNOP",
		"jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
		"-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
		"sk-ant-abcdefghijklmnopqrstu",
	].join("\n");
	const out = redact(input);
	for (const secret of ["abcdefghijklmnop", "ghp_abcdef", "hunter22", "s3cretpw", "AKIAABCDEFGHIJKLMNOP", "dozjgNry", "MIIEow", "sk-ant-abc"]) {
		assert.ok(!out.includes(secret), `leaked ${secret}: ${out}`);
	}
	assert.equal(redact("plain build output: 42 tests passed"), "plain build output: 42 tests passed");
});

test("text helpers", () => {
	assert.equal(clip("abcdef", 3), "abc… [3 more chars]");
	assert.deepEqual(lastLines("a\nb\nc\n", 2), ["b", "c"]);
	assert.equal(formatDuration(59_000), "59s");
	assert.equal(formatDuration(252_000), "4m12s");
	assert.equal(formatDuration(3_900_000), "1h05m");
	assert.equal(sanitizeTerminal("a\u001b[1mb\u001b[0m\rc"), "ab\nc");
});

test("watch until notifies once", () => {
	const w = new Watcher({ pattern: "ready on port \\d+", mode: "until" });
	assert.deepEqual(w.push("booting", 0), {});
	assert.deepEqual(w.push("ready on port 3000", 1), { notify: ["ready on port 3000"] });
	assert.deepEqual(w.push("ready on port 3000", 2), {});
	assert.equal(w.exhausted, true);
});

test("watch each coalesces and honours the budget", () => {
	const w = new Watcher({ pattern: "error", flags: "i", mode: "each", maxEvents: 2, coalesceMs: 100 });
	assert.deepEqual(w.push("ERROR one", 0), { flushAt: 100 });
	assert.deepEqual(w.push("error two", 50), {});
	assert.deepEqual(w.flush(), ["ERROR one", "error two"]);
	assert.deepEqual(w.push("error three", 200), { flushAt: 300 });
	assert.deepEqual(w.flush(), ["error three"]);
	assert.equal(w.exhausted, true);
	assert.deepEqual(w.push("error four", 400), {});
	assert.equal(w.flush(), undefined);
});

test("watch rejects bad flags", () => {
	assert.throws(() => new Watcher({ pattern: "x", flags: "q" }));
	assert.throws(() => new Watcher({ pattern: "" }));
});

test("line splitter handles partial and long lines", () => {
	const s = new LineSplitter(5);
	assert.deepEqual(s.push("ab"), []);
	assert.deepEqual(s.push("c\r\nde"), ["abc"]);
	assert.deepEqual(s.push("fghij"), ["defgh"]);
	assert.deepEqual(s.end(), []);
});

const notice = (extra: Partial<TaskNotice>): TaskNotice => ({
	kind: "exit",
	id: "bg1",
	label: "verify",
	command: "pnpm run verify",
	logPath: "/tmp/bg1.log",
	durationMs: 252_000,
	exitCode: 0,
	signal: null,
	lines: ["ok 42 tests"],
	stillRunning: false,
	...extra,
});

test("task notices are compact and name the log", () => {
	const text = formatNotice(notice({}));
	assert.match(text, /^task bg1 "verify" exited 0 after 4m12s/);
	assert.match(text, /│ ok 42 tests/);
	assert.match(text, /log: \/tmp\/bg1.log/);
	assert.match(formatNotice(notice({ exitCode: 2 })), /FAILED with exit 2/);
	assert.match(formatNotice(notice({ kind: "match", pattern: "done", stillRunning: true, eventNumber: 1, maxEvents: 1 })), /matched \/done\/ after 4m12s · still running/);
	assert.match(formatNotice(notice({ kind: "timeout" })), /hit its deadline/);
	const many = formatNotices([notice({}), notice({ id: "bg2", label: "bg2" })]);
	assert.match(many, /^pi-bg: 2 background task updates/);
	assert.match(formatNotice(notice({ lines: ["password=supersecret1"] })), /\[REDACTED\]/);
});

test("footer text combines tasks and bridge state", () => {
	assert.equal(footerText(0, undefined, 0), undefined);
	assert.equal(footerText(2, initialState(), 0), "⏵ 2 bg");
	const waiting = { ...initialState(), phase: "waiting" as const, runId: "run_8da5785a70be" };
	assert.equal(footerText(0, waiting, 0), "orca ◉ run_8da5");
	const pending = { ...waiting, phase: "pending" as const, pendingSince: 0 };
	assert.equal(footerText(1, pending, 125_000), "⏵ 1 bg · orca ◆ ack pending 2m05s run_8da5");
});
