import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { backoffDelay, TRANSPORT_BACKOFF } from "../lib/backoff.ts";
import { redact } from "../lib/redact.ts";
import { footerText } from "../lib/status.ts";
import { initialState } from "../lib/orca/machine.ts";
import { clip, formatDuration, lastLines, sanitizeTerminal } from "../lib/text.ts";
import { formatNotice, formatNotices, type TaskNotice } from "../lib/tasks/notice.ts";
import { LineSplitter, Watcher } from "../lib/tasks/watch.ts";
import { createWakeBudget, takeWake } from "../lib/wake-budget.ts";

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

test("redact hides multiline PEM keys and orphaned PEM body lines", () => {
	const body = ["MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun", "VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK"];
	const whole = ["before", "-----BEGIN RSA PRIVATE KEY-----", ...body, "-----END RSA PRIVATE KEY-----", "after"].join("\n");
	const cut = [...body, "-----END RSA PRIVATE KEY-----", "after"].join("\n");
	for (const text of [whole, cut]) {
		const out = redact(text);
		assert.ok(!out.includes("MIIEowIBAAKCAQEAu1SU") && !out.includes("VTLw7onLRnrq0"), out);
		assert.match(out, /after$/);
	}
	const sha = "0b0073b2f1c9d8e7a6b5c4d3e2f1a0b9c8d7e6f5";
	assert.equal(redact(`commit ${sha}`), `commit ${sha}`);
	const lines = formatNotice(notice({ lines: whole.split("\n") }));
	assert.ok(!lines.includes("MIIEowIBAAKCAQEAu1SU") && !lines.includes("VTLw7onLRnrq0"), lines);
});

test("redact hides every body line of generated keys, whole or with BEGIN cut off", () => {
	const keys = {
		rsa: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
		rsaPkcs1: generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
		ec: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "sec1", format: "pem" }).toString(),
	};
	for (const [name, pem] of Object.entries(keys)) {
		const lines = pem.trimEnd().split("\n");
		const body = lines.slice(1, -1);
		const texts = {
			whole: ["building", ...lines, "done"].join("\n"),
			noBegin: [...lines.slice(1), "done"].join("\n"),
			cutFirstBody: [...lines.slice(2), "done"].join("\n"),
			lastBodyOnly: ["building", lines.at(-2), lines.at(-1), "done"].join("\n"),
		};
		for (const [shape, text] of Object.entries(texts)) {
			const out = redact(text);
			for (const line of body) assert.ok(!out.includes(line), `${name}/${shape} leaked ${line}: ${out}`);
			assert.match(out, /done$/, `${name}/${shape}`);
		}
	}
	const openssh = ["b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW", "QyNTUxOQAAACAb", "-----END OPENSSH PRIVATE KEY-----"].join("\n");
	assert.ok(!redact(openssh).includes("QyNTUxOQAAACAb"));
});

test("redact leaves ordinary build output unchanged", () => {
	const output = [
		"> pi-bg@0.1.0 build /home/alex/src/pi-bg",
		"commit 0b0073b2f1c9d8e7a6b5c4d3e2f1a0b9c8d7e6f5",
		"src/index.ts",
		"OK",
		"compiled 12 files in 3.4s",
		"-----END-OF-BUILD-----",
		"ok 42 tests passed",
	].join("\n");
	assert.equal(redact(output), output);
});

test("grouped notices keep every headline even when details overflow", () => {
	const many = Array.from({ length: 30 }, (_, i) => notice({ id: `bg${i}`, label: `bg${i}`, exitCode: i === 29 ? 1 : 0, lines: Array.from({ length: 15 }, () => "x".repeat(300)) }));
	const text = formatNotices(many);
	assert.ok(text.length <= 8_000, String(text.length));
	for (let i = 0; i < 30; i++) assert.ok(text.includes(`- task bg${i} `), `missing bg${i}`);
	assert.match(text, /task bg29 FAILED with exit 1/);
});


test("wake budget caps turns per window", () => {
	let b = createWakeBudget(2, 1000);
	let r = takeWake(b, 0);
	assert.equal(r.allowed, true);
	r = takeWake(r.budget, 10);
	assert.equal(r.allowed, true);
	r = takeWake(r.budget, 20);
	assert.equal(r.allowed, false);
	r = takeWake(r.budget, 1001);
	assert.equal(r.allowed, true);
	b = r.budget;
	assert.equal(b.wakes.length, 2);
});
