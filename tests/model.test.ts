import { test } from "node:test";
import assert from "node:assert/strict";
import { formatModel, parsePiStatusModel, profileModel, resolveWorkerModel } from "../lib/orca/model.ts";

test("explicit launch model wins over a different visible status and profile default", () => {
	const model = resolveWorkerModel({
		launch: { provider: "anthropic", model: "claude-sonnet-4", thinking: "high" },
		status: { provider: "openai-codex", model: "gpt-6-luna", thinking: "max" },
		profile: { provider: "openai-codex", model: "gpt-6-luna", thinking: "max" },
	});
	assert.deepEqual(model, { provider: "anthropic", model: "claude-sonnet-4", thinking: "high", source: "launch" });
	assert.equal(formatModel(model), "anthropic/claude-sonnet-4 · high");
});

test("visible Pi status wins over profile defaults and reads provider plus thinking", () => {
	const tail = [
		"─".repeat(100),
		"/tmp/worker",
		"↑23k ↓4.3k R139k CH96.6% $0.006 (sub) 2.4%/700k (auto) (openai-codex) gpt-6-luna • max",
	];
	const status = parsePiStatusModel(tail);
	assert.deepEqual(status, { provider: "openai-codex", model: "gpt-6-luna", thinking: "max", source: "status" });
	assert.deepEqual(resolveWorkerModel({ status, profile: { provider: "anthropic", model: "claude-sonnet-4", thinking: "low" } }), status);
});

test("profile model uses provider and model-specific thinking settings", () => {
	assert.deepEqual(profileModel({
		defaultProvider: "openai-codex",
		defaultModel: "gpt-6-luna",
		defaultThinkingLevel: "medium",
		modelThinkingLevels: { "openai-codex/gpt-6-luna": "max" },
	}), { provider: "openai-codex", model: "gpt-6-luna", thinking: "max", source: "default" });
	assert.deepEqual(profileModel({ defaultProvider: "openai-codex", defaultModel: "openai-codex/gpt-6-luna", defaultThinkingLevel: "max" }), {
		provider: "openai-codex", model: "gpt-6-luna", thinking: "max", source: "default",
	});
});

test("a reused terminal has no guessed profile model, but observed status is still authoritative", () => {
	assert.equal(resolveWorkerModel({ profile: { provider: "openai-codex", model: "gpt-6-luna" }, reusedTerminal: true }), undefined);
	assert.deepEqual(resolveWorkerModel({ status: { provider: "openai-codex", model: "gpt-6-luna" }, profile: { provider: "anthropic", model: "claude" }, reusedTerminal: true }), {
		provider: "openai-codex", model: "gpt-6-luna", source: "status",
	});
});

test("malformed settings and non-Pi status lines do not invent a model", () => {
	assert.equal(profileModel({ defaultProvider: "openai-codex", defaultModel: { id: "gpt-6-luna" } }), undefined);
	assert.equal(parsePiStatusModel(["(openai-codex) gpt-6-luna • max"]), undefined, "requires Pi's context-bearing status bar");
	assert.equal(resolveWorkerModel({}), undefined);
});
