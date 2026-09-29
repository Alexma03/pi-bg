import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { trimWorkerScreen } from "../lib/orca/screen.ts";

test("worker screen tail removes spinner and footer noise while preserving a question and choices", async () => {
	const raw = (await readFile(new URL("./fixtures/watchdog/pi-picker.txt", import.meta.url), "utf8")).trimEnd().split(/\r?\n/);
	const tail = ["── ⠦ Working ───────────────────", ...raw, "↑10k ↓4k 1.5%/700k (auto) (openai-codex) gpt-6-luna • max", "orca ◉ escuchando"];
	assert.deepEqual(trimWorkerScreen(tail, 10), [
		"Ask user question",
		"Which test scope should I run?",
		"❯ Unit tests",
		"Unit plus integration tests",
		"Skip tests",
		"↑↓ navigate • Enter select • Esc cancel",
	]);
});

test("screen tail is bounded and keeps the newest useful lines", () => {
	assert.deepEqual(trimWorkerScreen(["first", "second", "── ⠦ Working ──", "third"], 2), ["second", "third"]);
});
