import { test } from "node:test";
import assert from "node:assert/strict";
import { activityKey, lastActivity, nextActivity } from "../lib/orca/activity.ts";
import { initialFleet, quietEvents, updateFleet, type WorkerRow } from "../lib/orca/fleet.ts";
import { formatWorkersTable } from "../lib/orca/fleet-format.ts";

// Real Gentle Shell tails captured with `orca orchestration worker-read` (Orca 1.4.212).
const CHROME_END = [
	"╭─ ✿ ──────────────────────────────────────╮",
	"│  type, or / for commands                 │",
	"╰──────────────────────────────────────────╯",
];

test("a running background task in the worker's own card wins", () => {
	const tail = [
		"✿ Gentle Shell ⟡ ~/Projects/pi-bg main ⟡ claude-opus-5-5 · high",
		"──────────────────────────────────────────",
		" bg_run",
		' Started bg1 "espera 3 min" (pid 3502230). (+2 lines)',
		" I'll wait for the background notice to come in and then wrap up my turn.",
		"╭─ ⏵ Segundo plano · 1 en marcha ─────────╮",
		"│ ⏵ en segundo plano · espera 3 min · 1m30s │",
		"╰──────────────────────────────────────────╯",
		...CHROME_END,
	];
	assert.equal(lastActivity(tail), "⏵ espera 3 min · 1m30s");
	// Workers still on the old card format.
	assert.equal(lastActivity(["│ ▸ bg1 espera 3 min · 1m30s │"]), "⏵ espera 3 min · 1m30s");
});

test("otherwise the last tool action: bash, file tools, named tools", () => {
	const bash = ["$ cd /x && pnpm test (timeout 120s)", "  ok 12", "ctrl+o to expand", " Tests are running fine.", ...CHROME_END];
	assert.equal(lastActivity(bash), "$ cd /x && pnpm test");
	const read = [" Leo el README.", "read ~/Projects/pi-bg/README.md", "# pi-bg", "ctrl+o to expand", ...CHROME_END];
	assert.equal(lastActivity(read), "read ~/Projects/pi-bg/README.md");
	const tool = [" bg_run", ' Started bg1 "espera 2 minutos" (pid 1). (+2 lines)', "🧠 context “pi-bg” …", "↳ ✓ loaded", ...CHROME_END];
	assert.equal(lastActivity(tool), 'bg_run · Started bg1 "espera 2 minutos" (pid 1).');
});

test("Pi's default TUI: the editor rules, cwd, token stats and status segments are chrome", () => {
	// Captured with worker-read from a plain `pi` worker (no Gentle Shell).
	const RULE_LINE = "─".repeat(120);
	const footer = [RULE_LINE, RULE_LINE, "/tmp/pi-bg-lab", "↑23k ↓4.3k R139k CH96.6% $0.006 (sub) 2.4%/700k (auto)                (openai-codex) gpt-6-luna • high", "orca ◉ escuchando"];
	const said = [" Sent msg_1462ba5bf442", " Took 0.1s", " Ya envié worker_done con resultado succeeded para esta tarea.", ...footer];
	assert.equal(lastActivity([" $ orca orchestration send --type worker_done", ...said]), "$ orca orchestration send --type worker_done", "the last tool action still wins");
	assert.equal(lastActivity([" Pensando.", ...footer]), "Pensando.");
	const working = [" $ sleep 90; echo fin-largo (timeout 180s)", " Elapsed 11.0s", "── ⠦ Working ──────────────────────", RULE_LINE, " escribe algo", RULE_LINE, "/tmp/pi-bg-lab", "↑10k ↓129 R9.7k CH95.9% $0.001 (sub) 1.5%/700k (auto)   (openai-codex) gpt-6-luna • high", "⏵ 1 tarea"];
	assert.equal(lastActivity(working), "$ sleep 90; echo fin-largo");
	assert.equal(lastActivity(footer), undefined);
	// Two rules followed by flush-left lines are not a footer without Pi's context usage line.
	const gentle = [" Resumen:", RULE_LINE, " sección", RULE_LINE, "$ pnpm test", "read ~/x/README.md"];
	assert.equal(lastActivity(gentle), "read ~/x/README.md");
});

test("falls back to the last line the agent wrote; nothing for pure chrome", () => {
	assert.equal(lastActivity([" Pensando en el plan.", ...CHROME_END]), "Pensando en el plan.");
	assert.equal(lastActivity(CHROME_END), undefined);
	assert.equal(lastActivity([]), undefined);
});

test("ticking clocks are not a change; a new command is", () => {
	assert.equal(activityKey("⏵ bg1 build · 1m30s"), activityKey("⏵ bg1 build · 2m05s"));
	const a = nextActivity(undefined, "$ pnpm test · 3s", 1000);
	const b = nextActivity(a, "$ pnpm test · 40s", 9000);
	assert.equal(b.since, 1000);
	assert.equal(nextActivity(b, "read README.md", 12_000).since, 12_000);
});

const row = (id: string, extra: Partial<WorkerRow> = {}): WorkerRow => ({
	dispatchId: id, taskId: `task_${id}`, runId: "run_r", workerState: "ready", dispatchStatus: "dispatched", terminalState: "active", terminalHandle: "", activity: "working", outcome: "in_progress", liveness: "live", livenessReason: "", observedAt: null, attention: [], requiresAction: false, nextAction: "none", ownership: "owned", provider: "pi", ...extra,
});

test("quiet: a working agent stuck on the same activity is reported once per episode", () => {
	const state = updateFleet(initialFleet(), [row("a"), row("b"), row("c", { ownership: "user_owned" })], [], 0).state;
	const activity = new Map([
		["a", { text: "$ pnpm test", since: 0 }],
		["b", { text: "⏵ bg1 build · 12m", since: 0 }],
		["c", { text: "$ vim", since: 0 }],
	]);
	assert.deepEqual(quietEvents(state, activity, 9 * 60_000), []);
	const events = quietEvents(state, activity, 11 * 60_000);
	assert.equal(events.length, 1);
	assert.equal(events[0].kind, "quiet");
	assert.equal(events[0].dispatchId, "a");
	assert.match(events[0].detail ?? "", /still at: \$ pnpm test/);
	assert.deepEqual(quietEvents(state, activity, 20 * 60_000), [], "same episode is not repeated");
	activity.set("a", { text: "$ pnpm lint", since: 21 * 60_000 });
	assert.equal(quietEvents(state, activity, 32 * 60_000).length, 1, "a new quiet episode is reported");
});

test("orca_workers table shows agent, model and what each worker does now", () => {
	const state = updateFleet(initialFleet(), [row("a")], [{ id: "task_a", title: "Tests", spec: "", status: "dispatched", deps: [], parentId: null }], 0).state;
	const text = formatWorkersTable(state, "run_r", 5 * 60_000, {
		activity: new Map([["a", { text: "$ pnpm test", since: 60_000 }]]),
		details: new Map([["a", { agent: "codex", model: "gpt-6-sol", effort: "", startedAt: 0, reusedTerminal: false }]]),
	});
	assert.match(text, /- Tests · a · in_progress · working 5m00s · codex gpt-6-sol · started 5m00s ago/);
	assert.match(text, /\n {4}now: \$ pnpm test \(unchanged 4m00s\)/);
});
