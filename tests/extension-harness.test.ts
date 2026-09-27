// Extension wiring tests (judgment A-009): load extensions/pi-bg.ts against a
// fake ExtensionAPI and exercise tools, guards, wake messages, Orca tool
// activation, Orca child-work events and the worker reminder. The Orca CLI
// is the fake fixture; the real Orca app is never touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import piBg from "../extensions/pi-bg.ts";

const FAKE = fileURLToPath(new URL("./fixtures/fake-orca.sh", import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for condition");
		await sleep(25);
	}
}

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }> }> }>();
	const handlers = new Map<string, Handler[]>();
	const sent: Array<{ message: { customType: string; content: string; details?: unknown }; options: unknown }> = [];
	const emitted: Array<{ channel: string; data: unknown }> = [];
	const entries: Array<{ customType: string; data: unknown }> = [];
	let activeTools: string[] = ["bash", "read"];
	const pi = {
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
		registerMessageRenderer: () => {},
		registerCommand: () => {},
		sendMessage: (message: never, options: unknown) => sent.push({ message, options }),
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
		events: { emit: (channel: string, data: unknown) => emitted.push({ channel, data }), on: () => () => {} },
	};
	const ctx = {
		cwd: tmpdir(),
		mode: "tui",
		hasUI: false,
		ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {} },
		sessionManager: { getSessionId: () => `s-${Math.random().toString(36).slice(2)}`, getBranch: () => entries.map((e) => ({ type: "custom", ...e })) },
		hasPendingMessages: () => false,
	};
	const fire = async (event: string, payload: unknown = {}) => {
		let last: unknown;
		for (const h of handlers.get(event) ?? []) last = await h(payload, ctx);
		return last;
	};
	return { pi, ctx, tools, sent, emitted, fire, active: () => activeTools };
}

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
	const saved: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(vars)) {
		saved[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		return await fn();
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

async function fakeOrcaDir(run: string | null) {
	const dir = await mkdtemp(join(tmpdir(), "pi-bg-ext-"));
	await mkdir(join(dir, "queue"));
	await writeFile(join(dir, "calls.log"), "");
	await writeFile(join(dir, "run.json"), JSON.stringify({ ok: true, result: { run: run ? { id: run } : null } }));
	await chmod(FAKE, 0o755);
	return dir;
}

test("outside Orca: bg tools only, and a finished task wakes the model with steer + triggerTurn", async () => {
	const state = await mkdtemp(join(tmpdir(), "pi-bg-state-"));
	await withEnv({ ORCA_TERMINAL_HANDLE: undefined, GENTLE_PI_AGENTS_CHILD: undefined, PI_BG_STATE_DIR: state }, async () => {
		const f = fakePi();
		piBg(f.pi as never);
		assert.ok(f.tools.has("bg_run") && !f.tools.has("orca_ack"));
		await f.fire("session_start");
		const r = await f.tools.get("bg_run")!.execute("t1", { command: "echo hi; exit 3", label: "demo" }, undefined, undefined, f.ctx);
		assert.match(r.content[0].text ?? "", /Started bg1 "demo"/);
		await until(() => f.sent.length === 1);
		const { message, options } = f.sent[0];
		assert.equal(message.customType, "pi-bg-task");
		assert.match(message.content, /FAILED with exit 3/);
		assert.deepEqual(options, { deliverAs: "steer", triggerTurn: true });
		assert.equal(f.emitted.length, 0, "no Orca child events outside Orca");
		await f.fire("session_shutdown");
	});
});

test("coordinator in Orca: tools activate with the Run, deliveries inject, guard blocks, bg work is reported to Orca", async () => {
	const state = await mkdtemp(join(tmpdir(), "pi-bg-state-"));
	const dir = await fakeOrcaDir("run_fake");
	await writeFile(join(dir, "queue", "0001.json"), JSON.stringify({ ok: true, result: { runId: "run_fake", deliveryId: "d1", messages: [{ id: "m1", type: "worker_done", from_handle: "term_w", subject: "done", body: "ok", payload: '{"outcome":"succeeded"}' }], replayed: false } }));
	await withEnv({ ORCA_TERMINAL_HANDLE: "term_test", GENTLE_PI_AGENTS_CHILD: undefined, PI_BG_STATE_DIR: state, PI_BG_ORCA_BIN: FAKE, FAKE_ORCA_DIR: dir }, async () => {
		const f = fakePi();
		piBg(f.pi as never);
		assert.ok(f.tools.has("orca_ack") && f.tools.has("orca_workers") && f.tools.has("orca_watch"));
		await f.fire("session_start");
		await until(() => f.sent.some((s) => s.message.customType === "pi-bg-orca"));
		const delivery = f.sent.find((s) => s.message.customType === "pi-bg-orca")!;
		assert.match(delivery.message.content, /Orca delivery d1/);
		assert.deepEqual(delivery.options, { deliverAs: "steer", triggerTurn: true });
		assert.ok(f.active().includes("orca_ack"), "coordinator tools active while the Run is bound");
		const blocked = (await f.fire("tool_call", { toolName: "bash", input: { command: "orca orchestration check --json" } })) as { block?: boolean };
		assert.equal(blocked?.block, true);
		const peek = await f.fire("tool_call", { toolName: "bash", input: { command: "orca orchestration check --peek --json" } });
		assert.equal(peek, undefined);
		await f.tools.get("bg_run")!.execute("t2", { command: "sleep 0.2" }, undefined, undefined, f.ctx);
		await until(() => f.emitted.some((e) => e.channel === "subagent:async-complete"));
		assert.equal(f.emitted[0].channel, "subagent:async-started");
		await f.fire("session_shutdown");
	});
});

test("in Orca without a bound Run (e.g. a worker): no coordinator tools and no guard", async () => {
	const state = await mkdtemp(join(tmpdir(), "pi-bg-state-"));
	const dir = await fakeOrcaDir(null);
	await withEnv({ ORCA_TERMINAL_HANDLE: "term_worker", GENTLE_PI_AGENTS_CHILD: undefined, PI_BG_STATE_DIR: state, PI_BG_ORCA_BIN: FAKE, FAKE_ORCA_DIR: dir }, async () => {
		const f = fakePi();
		piBg(f.pi as never);
		await f.fire("session_start");
		await sleep(400);
		assert.ok(!f.active().includes("orca_ack"));
		assert.equal(await f.fire("tool_call", { toolName: "bash", input: { command: "orca orchestration check --terminal term_worker --json" } }), undefined);
		await f.fire("session_shutdown");
	});
});

test("gentle subagent children never consume the coordinator's mailbox", async () => {
	const state = await mkdtemp(join(tmpdir(), "pi-bg-state-"));
	await withEnv({ ORCA_TERMINAL_HANDLE: "term_lead", GENTLE_PI_AGENTS_CHILD: "1", PI_BG_STATE_DIR: state }, async () => {
		const f = fakePi();
		piBg(f.pi as never);
		assert.ok(!f.tools.has("orca_ack"));
		await f.fire("session_start");
		const blocked = (await f.fire("tool_call", { toolName: "bash", input: { command: "orca orchestration check --wait --json" } })) as { block?: boolean };
		assert.equal(blocked?.block, true);
		await f.fire("session_shutdown");
	});
});

test("worker reminder: a completed turn without worker_done gets one continuation", async () => {
	const state = await mkdtemp(join(tmpdir(), "pi-bg-state-"));
	const dir = await fakeOrcaDir(null);
	await withEnv({ ORCA_TERMINAL_HANDLE: "term_worker", GENTLE_PI_AGENTS_CHILD: undefined, PI_BG_STATE_DIR: state, PI_BG_ORCA_BIN: FAKE, FAKE_ORCA_DIR: dir }, async () => {
		const f = fakePi();
		piBg(f.pi as never);
		await f.fire("session_start");
		await f.fire("input", { text: "orca orchestration send --from term_worker --type escalation --task-id task_abc --dispatch-id ctx_abc\n=== TASK ===\nDo X" });
		const r = (await f.fire("agent_before_settle", { outcome: "completed" })) as { continue?: boolean; entries?: Array<{ content: string }> };
		assert.equal(r?.continue, true);
		assert.match(r?.entries?.[0].content ?? "", /ctx_abc/);
		await f.fire("tool_result", { toolName: "bash", input: { command: "orca orchestration send --type worker_done --task-id task_abc --dispatch-id ctx_abc" }, content: [{ type: "text", text: '{"ok": true}' }], isError: false });
		assert.equal(await f.fire("agent_before_settle", { outcome: "completed" }), undefined);
		await f.fire("session_shutdown");
	});
});

test("worker mail: a coordinator message detaches the running command and reaches the model", async () => {
	const state = await mkdtemp(join(tmpdir(), "pi-bg-state-"));
	const dir = await fakeOrcaDir(null);
	await withEnv({ ORCA_TERMINAL_HANDLE: "term_worker", GENTLE_PI_AGENTS_CHILD: undefined, PI_BG_STATE_DIR: state, PI_BG_ORCA_BIN: FAKE, FAKE_ORCA_DIR: dir }, async () => {
		const { spawn } = await import("node:child_process");
		const f = fakePi();
		piBg(f.pi as never);
		await f.fire("session_start");
		// Orca types the preamble; the first mail peek runs ~2 s later.
		await f.fire("input", { text: "orca orchestration send --from term_worker --type worker_done --task-id task_abc --dispatch-id ctx_abc\n=== TASK ===\nDo X" });
		// Lifecycle commands stay in the foreground; ordinary ones are attached.
		const orcaCall = { toolName: "bash", toolCallId: "c0", input: { command: "orca orchestration send --type status --task-id task_abc" } };
		await f.fire("tool_call", orcaCall);
		assert.equal(orcaCall.input.command, "orca orchestration send --type status --task-id task_abc");
		const call = { toolName: "bash", toolCallId: "c1", input: { command: "echo empieza; sleep 20; echo fin" } };
		await f.fire("tool_call", call);
		assert.match(call.input.command, /^# pi-bg bg1 \(moves to the background if your coordinator writes\): echo empieza; sleep 20; echo fin\nexec /);
		// Stand in for the bash tool: run the rewritten command.
		const started = Date.now();
		const bash = spawn("bash", ["-c", call.input.command], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		bash.stdout.on("data", (d) => (out += d));
		const exited = new Promise<number | null>((resolve) => bash.on("close", resolve));
		await sleep(500);
		await writeFile(join(dir, "queue", "0001.json"), JSON.stringify({ ok: true, result: { runId: "run_fake", messages: [{ id: "msg_1", type: "status", from_handle: "term_coord", subject: "Cambio de plan", body: "Para y revisa solo el README." }], count: 1 } }));
		await until(() => f.sent.some((s) => s.message.customType === "pi-bg-worker-mail"), 6_000);
		const code = await exited;
		assert.equal(code, 0);
		assert.ok(Date.now() - started < 5_000, "the bash call returned long before the 20 s command");
		assert.match(out, /^empieza\n/);
		assert.match(out, /Moved to the background as bg1/);
		const mail = f.sent.find((s) => s.message.customType === "pi-bg-worker-mail")!;
		assert.deepEqual(mail.options, { deliverAs: "steer", triggerTurn: true });
		assert.match(mail.message.content, /your coordinator sent 1 new message/);
		assert.match(mail.message.content, /status: Cambio de plan\n {2}Para y revisa solo el README\./);
		assert.match(mail.message.content, /moved to the background as bg1/);
		assert.match(mail.message.content, /check --terminal term_worker --json/);
		// The call ended detached: the command keeps running.
		await f.fire("tool_execution_end", { toolCallId: "c1", toolName: "bash", result: {}, isError: false });
		const status = await f.tools.get("bg_status")!.execute("s", {}, undefined, undefined, f.ctx);
		assert.match(status.content[0].text ?? "", /bg1.*running/);
		await f.fire("session_shutdown");
	});
});

test("worker attach: an aborted or timed-out bash call cancels its attached command", async () => {
	const state = await mkdtemp(join(tmpdir(), "pi-bg-state-"));
	const dir = await fakeOrcaDir(null);
	await withEnv({ ORCA_TERMINAL_HANDLE: "term_worker", GENTLE_PI_AGENTS_CHILD: undefined, PI_BG_STATE_DIR: state, PI_BG_ORCA_BIN: FAKE, FAKE_ORCA_DIR: dir }, async () => {
		const f = fakePi();
		piBg(f.pi as never);
		await f.fire("session_start");
		await f.fire("input", { text: "orca orchestration send --from term_worker --task-id task_abc --dispatch-id ctx_abc\n=== TASK ===\nDo X" });
		const call = { toolName: "bash", toolCallId: "c1", input: { command: "sleep 30" } };
		await f.fire("tool_call", call);
		await f.fire("tool_execution_end", { toolCallId: "c1", toolName: "bash", result: {}, isError: true });
		const status = await f.tools.get("bg_status")!.execute("s", {}, undefined, undefined, f.ctx);
		assert.match(status.content[0].text ?? "", /bg1.*cancelled/);
		await f.fire("session_shutdown");
	});
});
