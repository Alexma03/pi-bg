import { test } from "node:test";
import assert from "node:assert/strict";
import { lastActivity } from "../lib/orca/activity.ts";

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
		"│ ▸ bg1 espera 3 min · 1m30s               │",
		"╰──────────────────────────────────────────╯",
		...CHROME_END,
	];
	assert.equal(lastActivity(tail), "⏵ bg1 espera 3 min · 1m30s");
});

test("otherwise the last tool action: bash, file tools, named tools", () => {
	const bash = ["$ cd /x && pnpm test (timeout 120s)", "  ok 12", "ctrl+o to expand", " Tests are running fine.", ...CHROME_END];
	assert.equal(lastActivity(bash), "$ cd /x && pnpm test");
	const read = [" Leo el README.", "read ~/Projects/pi-bg/README.md", "# pi-bg", "ctrl+o to expand", ...CHROME_END];
	assert.equal(lastActivity(read), "read ~/Projects/pi-bg/README.md");
	const tool = [" bg_run", ' Started bg1 "espera 2 minutos" (pid 1). (+2 lines)', "🧠 context “pi-bg” …", "↳ ✓ loaded", ...CHROME_END];
	assert.equal(lastActivity(tool), 'bg_run · Started bg1 "espera 2 minutos" (pid 1).');
});

test("falls back to the last line the agent wrote; nothing for pure chrome", () => {
	assert.equal(lastActivity([" Pensando en el plan.", ...CHROME_END]), "Pensando en el plan.");
	assert.equal(lastActivity(CHROME_END), undefined);
	assert.equal(lastActivity([]), undefined);
});
