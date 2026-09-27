// Extension wiring tests (judgment A-009): load extensions/pi-bg.ts against a
// fake ExtensionAPI and exercise tools, guards, wake messages, Orca tool
// activation, Orca child-work events and the worker reminder. The Orca CLI
// is the fake fixture; the real Orca app is never touched.

import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
	const userSent: Array<{ text: string; options: unknown }> = [];
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
	type Widget = { render(width: number): string[]; handleMouse?(event: unknown): { handled?: boolean } | undefined };
	const widgets = new Map<string, Widget>();
	const state = { idle: false, rejectPrompt: false };
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
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => unknown }) => commands.set(name, command),
		sendMessage: (message: never, options: unknown) => sent.push({ message, options }),
		sendUserMessage: (text: string, options: unknown) => {
			userSent.push({ text, options });
			return state.rejectPrompt ? Promise.reject(new Error("no model")) : Promise.resolve();
		},
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
		ui: {
			setStatus: () => {},
			setWidget: (key: string, factory: ((tui: unknown, theme: unknown) => Widget) | undefined) => {
				if (factory) widgets.set(key, factory({ requestRender: () => {} }, { fg: (_c: string, t: string) => t }));
				else widgets.delete(key);
			},
			notify: () => {},
		},
		sessionManager: { getSessionId: () => `s-${Math.random().toString(36).slice(2)}`, getBranch: () => entries.map((e) => ({ type: "custom", ...e })) },
		hasPendingMessages: () => false,
		isIdle: () => state.idle,
	};
	const fire = async (event: string, payload: unknown = {}) => {
		let last: unknown;
		for (const h of handlers.get(event) ?? []) last = await h(payload, ctx);
		return last;
	};
	return { pi, ctx, tools, sent, userSent, state, commands, widgets, emitted, fire, active: () => activeTools };
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
		const r = await f.tools.get("bg_run")!.execute("t1", { command: "echo hi; exit 3", label: "demo", timeout_s: 60 }, undefined, undefined, f.ctx);
		assert.match(r.content[0].text ?? "", /Started bg1 "demo" \(pid \d+\) · deadline 1m00s/);
		await until(() => f.sent.length === 1);
		const { message, options } = f.sent[0];
		assert.equal(message.customType, "pi-bg-task");
		assert.match(message.content, /FAILED with exit 3/);
		assert.deepEqual(options, { deliverAs: "steer", triggerTurn: true });
		assert.equal(f.emitted.length, 0, "no Orca child events outside Orca");
		await f.fire("session_shutdown");
	});
});

test("an idle session is woken through a user prompt (before_agent_start runs); a busy one gets a steer", async () => {
	// Pi skips before_agent_start for a turn started by sendMessage({triggerTurn}), so
	// extensions that build the system prompt there (Gentle Shell) are missing from it,
	// and claude-bridge refuses the turn. A user prompt from the extension goes through it.
	const state = await mkdtemp(join(tmpdir(), "pi-bg-state-"));
	await withEnv({ ORCA_TERMINAL_HANDLE: undefined, GENTLE_PI_AGENTS_CHILD: undefined, PI_BG_STATE_DIR: state }, async () => {
		const f = fakePi();
		piBg(f.pi as never);
		await f.fire("session_start");
		f.state.idle = true;
		await f.tools.get("bg_run")!.execute("t1", { command: "exit 3", label: "idle", timeout_s: 60 }, undefined, undefined, f.ctx);
		await until(() => f.userSent.length === 1);
		assert.deepEqual(f.sent.at(-1)!.options, { deliverAs: "nextTurn" }, "the notice rides along with the prompt");
		assert.match(f.sent.at(-1)!.message.content, /FAILED with exit 3/);
		assert.match(f.userSent[0].text, /^⟳ pi-bg: /);
		assert.deepEqual(f.userSent[0].options, { deliverAs: "steer" }, "still queued if the session got busy meanwhile");
		f.state.idle = false;
		await f.tools.get("bg_run")!.execute("t2", { command: "exit 4", label: "busy", timeout_s: 60 }, undefined, undefined, f.ctx);
		await until(() => f.sent.length === 2);
		assert.deepEqual(f.sent[1].options, { deliverAs: "steer", triggerTurn: true });
		assert.equal(f.userSent.length, 1, "no prompt while busy");
		// If the wake prompt is refused, the notice is still delivered at once the old way.
		f.state.idle = true;
		f.state.rejectPrompt = true;
		await f.tools.get("bg_run")!.execute("t3", { command: "exit 5", label: "refused", timeout_s: 60 }, undefined, undefined, f.ctx);
		await until(() => f.sent.some((x) => /exit 5/.test(x.message.content) && (x.options as { triggerTurn?: boolean }).triggerTurn === true));
		await f.fire("session_shutdown");
	});
});

test("a click on a card folds it to one line and a second click unfolds it; /bg card fold does the same", async () => {
	const state = await mkdtemp(join(tmpdir(), "pi-bg-state-"));
	await withEnv({ ORCA_TERMINAL_HANDLE: undefined, GENTLE_PI_AGENTS_CHILD: undefined, PI_BG_STATE_DIR: state }, async () => {
		const f = fakePi();
		(f.ctx as { hasUI: boolean }).hasUI = true;
		piBg(f.pi as never);
		await f.fire("session_start");
		await f.tools.get("bg_run")!.execute("t1", { command: "sleep 5", label: "espera", timeout_s: 60 }, undefined, undefined, f.ctx);
		const card = f.widgets.get("pi-bg-card")!;
		const open = card.render(60).filter(Boolean);
		assert.ok(open.length >= 3, open.join("\n"));
		const mouse = (type: string, y: number) => card.handleMouse!({ type, button: "left", x: 3, y, screenX: 3, screenY: y, width: 60, height: open.length + 1, shift: false, alt: false, ctrl: false });
		// Fullscreen turns press + release into a click only for a component that claimed the press.
		const click = (y: number) => {
			assert.deepEqual(mouse("press", y), { handled: true, render: false }, "the press is claimed");
			return mouse("click", y);
		};
		assert.equal(mouse("press", open.length), undefined, "the spacer line below the card is not part of it");
		assert.equal(card.handleMouse!({ type: "wheel", button: "none", x: 0, y: 0, screenX: 0, screenY: 0, width: 60, height: 4, shift: false, alt: false, ctrl: false }), undefined, "only clicks");
		assert.deepEqual(click(1), { handled: true, render: true });
		const folded = card.render(60).filter(Boolean);
		assert.equal(folded.length, 1);
		assert.match(folded[0], /Segundo plano · 1 en marcha ▸/);
		click(0);
		assert.equal(card.render(60).filter(Boolean).length, open.length);
		await f.commands.get("bg")!.handler("card fold", f.ctx);
		assert.equal(f.widgets.get("pi-bg-card")!.render(60).filter(Boolean).length, 1, "/bg card fold folds the cards");
		await f.commands.get("bg")!.handler("card fold", f.ctx);
		assert.equal(f.widgets.get("pi-bg-card")!.render(60).filter(Boolean).length, open.length, "and again unfolds them");
		await f.fire("session_shutdown");
	});
});

test("bg_run refuses a task without a deadline or with a missing cwd, before starting anything", async () => {
	const state = await mkdtemp(join(tmpdir(), "pi-bg-state-"));
	await withEnv({ ORCA_TERMINAL_HANDLE: undefined, GENTLE_PI_AGENTS_CHILD: undefined, PI_BG_STATE_DIR: state }, async () => {
		const f = fakePi();
		piBg(f.pi as never);
		await f.fire("session_start");
		const run = f.tools.get("bg_run")!;
		await assert.rejects(run.execute("t1", { command: "true" }, undefined, undefined, f.ctx), /timeout_s is required/);
		await assert.rejects(run.execute("t2", { command: "true", timeout_s: 0 }, undefined, undefined, f.ctx), /timeout_s is required/);
		await assert.rejects(run.execute("t3", { command: "true", timeout_s: 60, cwd: join(state, "missing") }, undefined, undefined, f.ctx), /cwd .*missing.* does not exist/);
		const ok = await run.execute("t4", { command: "true", timeout_s: 60 }, undefined, undefined, f.ctx);
		assert.match(ok.content[0].text ?? "", /Started bg1 /, "refused calls do not consume ids");
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
		await f.tools.get("bg_run")!.execute("t2", { command: "sleep 0.2", timeout_s: 60 }, undefined, undefined, f.ctx);
		await until(() => f.emitted.some((e) => e.channel === "subagent:async-complete"));
		assert.equal(f.emitted[0].channel, "subagent:async-started");
		await f.fire("session_shutdown");
	});
});

test("a fleet notice that waits for the next turn carries no live state (it would be stale when read)", async () => {
	const state = await mkdtemp(join(tmpdir(), "pi-bg-state-"));
	const dir = await fakeOrcaDir("run_fake");
	const worker = (outcome: string) => ({
		ok: true,
		result: {
			workers: [{ dispatchId: "ctx_a", taskId: "task_a", runId: "run_fake", workerState: outcome === "in_progress" ? "ready" : outcome, dispatchStatus: outcome === "in_progress" ? "dispatched" : "completed", terminalState: "active", agentTerminalHandle: "term_a", resource: { ownershipState: "owned" }, projection: { stage: { activity: "working" }, outcome, liveness: { verdict: "live", observedAt: new Date().toISOString() }, attention: { categories: [], requiresAction: false }, nextAction: { kind: "none" } } }],
			page: { hasMore: false, nextCursor: null },
		},
	});
	await writeFile(join(dir, "workers.json"), JSON.stringify(worker("in_progress")));
	await withEnv({ ORCA_TERMINAL_HANDLE: "term_test", GENTLE_PI_AGENTS_CHILD: undefined, PI_BG_STATE_DIR: state, PI_BG_ORCA_BIN: FAKE, FAKE_ORCA_DIR: dir }, async () => {
		const f = fakePi();
		piBg(f.pi as never);
		await f.fire("session_start");
		await until(() => readFileSync(join(dir, "calls.log"), "utf8").includes("worker-list"));
		await sleep(300);
		await writeFile(join(dir, "workers.json"), JSON.stringify(worker("succeeded")));
		await f.fire("tool_result", { toolName: "bash", input: { command: "orca orchestration worker-start --spec x --json" }, content: [], isError: false });
		await until(() => f.sent.some((x) => x.message.customType === "pi-bg-fleet"), 8_000);
		const notice = f.sent.find((x) => x.message.customType === "pi-bg-fleet")!;
		assert.match(notice.message.content, /settled/);
		assert.deepEqual(notice.options, { deliverAs: "nextTurn" });
		assert.doesNotMatch(notice.message.content, /pi-bg live state/);
		await f.fire("session_shutdown");
	});
});

test("in Orca without a bound Run: coordinator tools ready for a later run-create, no guard; a worker preamble hides them", async () => {
	const state = await mkdtemp(join(tmpdir(), "pi-bg-state-"));
	const dir = await fakeOrcaDir(null);
	await withEnv({ ORCA_TERMINAL_HANDLE: "term_worker", GENTLE_PI_AGENTS_CHILD: undefined, PI_BG_STATE_DIR: state, PI_BG_ORCA_BIN: FAKE, FAKE_ORCA_DIR: dir }, async () => {
		const f = fakePi();
		piBg(f.pi as never);
		await f.fire("session_start");
		await sleep(400);
		// Providers such as claude-bridge freeze the tool list for a whole turn, so the tools
		// must already be there when a run-create happens mid-turn.
		assert.ok(f.active().includes("orca_ack"));
		await assert.rejects(f.tools.get("orca_ack")!.execute("a1", { deliveryId: "d1" }, undefined, undefined, f.ctx), /no .*delivery|not/i);
		assert.equal(await f.fire("tool_call", { toolName: "bash", input: { command: "orca orchestration check --terminal term_worker --json" } }), undefined);
		await f.fire("input", { text: "=== TASK ===\nDo it.\norca orchestration worker_done --task-id task_1 --dispatch-id ctx_1 --from term_worker" });
		assert.ok(!f.active().includes("orca_ack"), "workers keep their preamble's check");
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
		// pi-bg's own wake prompt is not new direction: the reminder gap still applies.
		await f.fire("input", { text: "⟳ pi-bg: 1 background task update", source: "extension" });
		assert.equal(await f.fire("agent_before_settle", { outcome: "completed" }), undefined);
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

test("any interactive session: a bash command still running after the threshold moves to the background by itself", async () => {
	const state = await mkdtemp(join(tmpdir(), "pi-bg-state-"));
	await withEnv({ ORCA_TERMINAL_HANDLE: undefined, GENTLE_PI_AGENTS_CHILD: undefined, PI_BG_STATE_DIR: state, PI_BG_AUTO_BACKGROUND_S: "1" }, async () => {
		const { spawn } = await import("node:child_process");
		const f = fakePi();
		(f.ctx as { hasUI: boolean }).hasUI = true;
		piBg(f.pi as never);
		await f.fire("session_start");
		// Fast commands and orca lifecycle calls are left alone; others run attached.
		const quick = { toolName: "bash", toolCallId: "q", input: { command: "echo hi" } };
		await f.fire("tool_call", quick);
		assert.match(quick.input.command, /attach-client/);
		const slow = { toolName: "bash", toolCallId: "s", input: { command: "sleep 3; echo done", timeout: 20 } };
		await f.fire("tool_call", slow);
		const child = spawn("bash", ["-c", slow.input.command.split("\n").slice(1).join("\n")]);
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		const code = await new Promise((r) => child.on("close", r));
		assert.equal(code, 0);
		assert.match(out, /still running after 1s, so it moved to the background as bg2/);
		await f.fire("tool_execution_end", { toolCallId: "s", toolName: "bash", result: {}, isError: false });
		const status = (await f.tools.get("bg_status")!.execute("st", { id: "bg2" }, undefined, undefined, f.ctx)).content[0].text ?? "";
		assert.match(status, /bg2 running/, "still running after the bash call returned");
		await until(() => f.sent.some((x) => /bg2 .*exited 0/.test(x.message.content)), 6_000);
		await f.fire("session_shutdown");
	});
});

test("gentle subagent children and non-interactive sessions never auto-background", async () => {
	for (const env of [{ GENTLE_PI_AGENTS_CHILD: "1", ui: true }, { GENTLE_PI_AGENTS_CHILD: undefined, ui: false }]) {
		const state = await mkdtemp(join(tmpdir(), "pi-bg-state-"));
		await withEnv({ ORCA_TERMINAL_HANDLE: undefined, GENTLE_PI_AGENTS_CHILD: env.GENTLE_PI_AGENTS_CHILD, PI_BG_STATE_DIR: state }, async () => {
			const f = fakePi();
			(f.ctx as { hasUI: boolean }).hasUI = env.ui;
			piBg(f.pi as never);
			await f.fire("session_start");
			const call = { toolName: "bash", toolCallId: "c", input: { command: "sleep 1" } };
			await f.fire("tool_call", call);
			assert.equal(call.input.command, "sleep 1");
			await f.fire("session_shutdown");
		});
	}
});

test("worker attach: a bash call without a timeout gets 30 s, one with a timeout keeps it even in the background", async () => {
	const state = await mkdtemp(join(tmpdir(), "pi-bg-state-"));
	const dir = await fakeOrcaDir(null);
	await withEnv({ ORCA_TERMINAL_HANDLE: "term_worker", GENTLE_PI_AGENTS_CHILD: undefined, PI_BG_STATE_DIR: state, PI_BG_ORCA_BIN: FAKE, FAKE_ORCA_DIR: dir }, async () => {
		const f = fakePi();
		piBg(f.pi as never);
		await f.fire("session_start");
		await f.fire("input", { text: "orca orchestration send --from term_worker --task-id task_abc --dispatch-id ctx_abc\n=== TASK ===\nDo X" });
		await f.fire("tool_call", { toolName: "bash", toolCallId: "c1", input: { command: "sleep 60" } });
		await f.fire("tool_call", { toolName: "bash", toolCallId: "c2", input: { command: "sleep 60", timeout: 1 } });
		const status = (await f.tools.get("bg_status")!.execute("s", {}, undefined, undefined, f.ctx)).content[0].text ?? "";
		assert.match(status, /bg1 running .*deadline 30s/);
		assert.match(status, /bg2 running .*deadline 1s/);
		await sleep(1600);
		const after = (await f.tools.get("bg_status")!.execute("s", { id: "bg2" }, undefined, undefined, f.ctx)).content[0].text ?? "";
		assert.match(after, /bg2 timeout/);
		const ctl = JSON.parse(await readFile(`${after.match(/log: (\S+)/)![1]}.ctl`, "utf8"));
		assert.match(ctl.error, /stopped at its 1s deadline.*timeout/);
		await f.fire("session_shutdown");
	});
});
