import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildBgCard, buildOrcaCard, renderCardLines, workerLook } from "../lib/ui/card.ts";
import { initialState } from "../lib/orca/machine.ts";
import { initialFleet, updateFleet, type WorkerRow } from "../lib/orca/fleet.ts";
import type { TaskSnapshot } from "../lib/tasks/manager.ts";

const task = (id: string, extra: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
	id,
	label: id,
	command: "sleep 1",
	cwd: "/tmp",
	pid: 1,
	status: "running",
	startedAt: 0,
	endedAt: undefined,
	exitCode: null,
	signal: null,
	logPath: "/tmp/x.log",
	bytes: 0,
	watch: undefined,
	watchEvents: 0,
	outputOffset: 0,
	...extra,
});

const worker = (id: string, extra: Partial<WorkerRow> = {}): WorkerRow => ({
	dispatchId: id, taskId: `task_${id}`, runId: "run_r", workerState: "ready", dispatchStatus: "dispatched", terminalState: "active", terminalHandle: "", activity: "working", outcome: "in_progress", liveness: "live", livenessReason: "", observedAt: null, attention: [], requiresAction: false, nextAction: "none", ownership: "owned", provider: "pi", ...extra,
});

const plainTheme = { fg: (_c: string, t: string) => t };

test("no cards when nothing runs and the bridge is off", () => {
	assert.equal(buildBgCard({ now: 0, tasks: [] }), undefined);
	assert.equal(buildOrcaCard({ now: 0, orca: initialState() }), undefined);
});

test("a command the agent is waiting on is not background work; once moved to the background it is", () => {
	// Only background work belongs in this card: a command the agent is waiting on is not.
	assert.equal(buildBgCard({ now: 32_000, tasks: [task("bg63", { attached: true, label: "bash · sleep 170; date -u +%T", command: "sleep 170; date -u +%T" })] }), undefined);
	// Once it moves to the background (its coordinator wrote), it is background work.
	const moved = buildBgCard({ now: 32_000, tasks: [task("bg63", { label: "bash · sleep 170; date -u +%T", command: "sleep 170; date -u +%T", timeoutMs: 180_000 })] });
	assert.deepEqual(moved!.rows.map((r) => r.text), ["⏵ 32s de 3m00s · sleep 170; date -u +%T"]);
});

test("time and deadline come first, so a long command never hides them", () => {
	const long = `cd /home/alex/Projects/financial-hub/financial-hub-serverful && ${"pnpm --filter @fh/market-api test -- --run ".repeat(4)}`;
	const card = buildBgCard({ now: 200_000, tasks: [task("bg1", { command: long, timeoutMs: 1_800_000 }), task("bg2", { command: long, status: "exited", exitCode: 0, endedAt: 199_000 })] });
	const [running, done] = card!.rows.map((r) => r.text);
	assert.ok(running.startsWith("⏵ 3m20s de 30m00s · cd /home/alex/"), running);
	assert.ok(done.startsWith("✔ terminó bien · 3m19s · cd /home/alex/"), done);
	assert.ok(running.length <= 110 && done.length <= 110, "the command is clipped");
	const lines = renderCardLines(card!, plainTheme, 60);
	assert.match(lines[1], /3m20s de 30m00s/, "visible even on a narrow terminal");
});

test("background card shows only tasks, in Spanish; Orca never leaks into it", () => {
	const end = 5 * 60_000 - 1000;
	const card = buildBgCard({
		now: 5 * 60_000,
		tasks: [
			task("bg1", { label: "verify" }),
			task("bg2", { status: "exited", exitCode: 2, endedAt: end }),
			task("bg3", { status: "exited", exitCode: 0, endedAt: end }),
			task("bg4", { status: "matched", endedAt: end }),
			task("bg5", { status: "timeout", endedAt: end }),
			task("bg6", { status: "cancelled", endedAt: end }),
		],
		lastLines: new Map([["bg1", "ok 12/40"]]),
	});
	assert.ok(card);
	assert.equal(card.tone, "warning");
	assert.equal(card.title, "Segundo plano · 1 en marcha");
	const text = card.rows.map((r) => r.text).join("\n");
	// Rows say what they are in words and never show internal ids.
	assert.match(text, /⏵ 5m00s · verify · ok 12\/40/, "no deadline known: just the time");
	assert.match(text, /✖ falló \(código 2\) · 4m59s · sleep 1/);
	assert.match(text, /✔ terminó bien · 4m59s · sleep 1/);
	assert.match(text, /✔ encontró el patrón · 4m59s · sleep 1/);
	assert.match(text, /✖ tiempo agotado · 4m59s · sleep 1/);
	assert.match(text, /■ cancelada · 4m59s · sleep 1/);
	assert.doesNotMatch(text, /\bbg\d/);
	assert.doesNotMatch(text, /orca|fleet|agente/);
	const lines = renderCardLines(card, plainTheme, 60);
	assert.ok(lines[0].startsWith("╭─ ⏵ Segundo plano · 1 en marcha"));
	assert.ok(lines.every((l) => visibleWidth(l) === 60), lines.join("\n"));
});

test("orca card names the Run by objective and shows each agent: task, state, time, agent, model, live activity", () => {
	const runId = "run_8da5785a70be";
	const orca = { ...initialState(), phase: "waiting" as const, runId };
	const tasks = [
		{ id: "task_a", title: "Revisar docs", spec: "Lee el README\ny resume", status: "dispatched", deps: [], parentId: null },
		{ id: "task_b", title: "Tests", spec: "Corre los tests", status: "dispatched", deps: [], parentId: null },
	];
	let fleet = updateFleet(initialFleet(), [worker("a", { activity: "done" }), worker("b")], tasks, 0).state;
	fleet = updateFleet(fleet, [worker("a", { activity: "done" }), worker("b")], undefined, 5 * 60_000).state;
	const details = new Map([
		["a", { agent: "pi", model: "", effort: "", startedAt: 0, reusedTerminal: false }],
		["b", { agent: "codex", model: "gpt-6-sol", effort: "high", startedAt: 60_000, reusedTerminal: false }],
	]);
	const activity = new Map([["a", { text: "$ pnpm test", since: 0 }], ["b", { text: "⏵ espera 3 min · 1m30s", since: 0 }]]);
	const card = buildOrcaCard({ now: 5 * 60_000, orca, fleet, objective: "Lab visual", details, activity, defaultModel: (agent) => (agent === "pi" ? "claude-opus-5-5" : undefined) });
	assert.ok(card);
	assert.equal(card.title, "Orca · Lab visual · 2 agentes");
	assert.equal(card.tone, "warning");
	const text = card.rows.map((r) => r.text);
	assert.deepEqual(text, [
		"⏸ agente · Revisar docs · parado 5m00s sin terminar · 5m00s · pi · claude-opus-5-5 (por defecto)",
		"  ↳ $ pnpm test",
		"◉ agente · Tests · trabajando · 4m00s · codex · gpt-6-sol high",
		"  ↳ ⏵ espera 3 min · 1m30s",
	]);
	assert.doesNotMatch(text.join("\n"), /Lee el README|Corre los tests/, "the launch prompt is not shown");
	const reused = buildOrcaCard({ now: 5 * 60_000, orca, fleet, objective: "Lab visual", details: new Map([["a", { agent: "", model: "", effort: "", startedAt: 0, reusedTerminal: true }]]), activity, defaultModel: () => "claude-opus-5-5" });
	assert.match(reused!.rows[0].text, / · pi$/, "no guessed default model for a worker dispatched into an existing terminal");
	assert.equal(card.rows[1].tone, "muted");
	assert.doesNotMatch(text.join("\n"), /run_8da5|delivery|listening/);
	const lines = renderCardLines(card, plainTheme, 60);
	assert.ok(lines.every((l) => visibleWidth(l) === 60), lines.join("\n"));
});

test("orca card hides with no agents unless the bridge needs attention", () => {
	const base = { ...initialState(), runId: "run_x" };
	const rowsOf = (orca: ReturnType<typeof initialState>, now = 125_000) => buildOrcaCard({ now, orca, fleet: initialFleet() })?.rows.map((r) => r.text);
	assert.equal(buildOrcaCard({ now: 0, orca: { ...base, phase: "waiting" }, fleet: initialFleet() }), undefined);
	assert.equal(buildOrcaCard({ now: 0, orca: { ...base, phase: "waiting" } }), undefined);
	assert.deepEqual(rowsOf({ ...base, phase: "pending", pendingSince: 0 }), ["◆ hay mensajes de los agentes sin procesar · 2m05s"]);
	assert.deepEqual(rowsOf({ ...base, phase: "backoff", reason: "transport error", retryAt: 155_000 }), ["⚠ sin conexión con Orca · reintento en 30s"]);
	assert.deepEqual(rowsOf({ ...base, phase: "backoff", reason: "another waiter exists", retryAt: 125_000 }), ["⚠ otra sesión está leyendo los mensajes · reintento en 0s"]);
	assert.deepEqual(rowsOf({ ...base, phase: "fenced", reason: "not the Run consumer" }), ["✕ esta terminal ya no coordina el Run"]);
	// Without an objective the short run id is the fallback name.
	assert.equal(buildOrcaCard({ now: 0, orca: { ...base, phase: "fenced" } })!.title, "Orca · run_x");
});

test("orca card stays while a settled agent still has to be released", () => {
	const orca = { ...initialState(), phase: "waiting" as const, runId: "run_x" };
	const fleet = updateFleet(initialFleet(), [worker("a", { outcome: "succeeded", workerState: "succeeded", nextAction: "release" })], [], 0).state;
	const card = buildOrcaCard({ now: 1000, orca, fleet });
	assert.ok(card);
	assert.equal(card.title, "Orca · run_x");
	assert.match(card.rows[0].text, /✔ agente · task_a · terminó · falta cerrarlo/);
});

test("worker states in plain words", () => {
	const at = (extra: Partial<WorkerRow>, since = 0, now = 60_000) => workerLook(worker("w", extra), since, now);
	assert.equal(at({}).state, "trabajando");
	// Working with the same activity for 10 min: "sin cambios"; waiting on its own bg task is fine.
	assert.equal(workerLook(worker("w"), 0, 11 * 60_000, undefined, { text: "$ pnpm test", since: 0 }).state, "sin cambios 11m00s");
	assert.equal(workerLook(worker("w"), 0, 11 * 60_000, undefined, { text: "⏵ bg1 build · 11m", since: 0 }).state, "trabajando");
	assert.equal(workerLook(worker("w"), 0, 5 * 60_000, undefined, { text: "$ pnpm test", since: 0 }).state, "trabajando");
	assert.equal(at({ activity: "idle" }).state, "esperando");
	assert.equal(at({ activity: "unknown" }).state, "arrancando");
	assert.equal(at({ activity: "blocked" }).state, "esperando una respuesta en su terminal");
	assert.equal(at({ livenessReason: "stale_status", activity: "idle" }).state, "sin señal");
	assert.equal(at({ nextAction: "release", outcome: "succeeded" }).state, "terminó · falta cerrarlo");
	assert.equal(at({ nextAction: "release", outcome: "failed" }).mark, "✖");
});

test("collapsed cards keep only problems", () => {
	const bg = buildBgCard({ now: 1000, tasks: [task("bg1")], collapsed: true });
	assert.ok(bg);
	assert.deepEqual(bg.rows.map((r) => r.text), ["… 1 más (/bg)"]);
	const orca = buildOrcaCard({ now: 1000, orca: { ...initialState(), phase: "fenced", runId: "run_x", reason: "not the Run consumer" }, collapsed: true });
	assert.ok(orca);
	assert.deepEqual(orca.rows.map((r) => r.text), ["✕ esta terminal ya no coordina el Run"]);
});
