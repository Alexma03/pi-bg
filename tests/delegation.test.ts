import { test } from "node:test";
import assert from "node:assert/strict";
import { delegationGuide } from "../lib/delegation.ts";

test("outside Orca there is nothing to add: bg_run and Gentle describe themselves", () => {
	assert.equal(delegationGuide({ orca: false, worker: false }), undefined);
});

test("a coordinator learns when a delegation needs its own Pi orchestrator", () => {
	const text = delegationGuide({ orca: true, worker: false }) ?? "";
	assert.match(text, /bg_run/);
	assert.match(text, /Gentle subagent/);
	assert.match(text, /Orca worker/);
	assert.match(text, /several fronts/);
	assert.match(text, /orca-cli/);
	assert.doesNotMatch(text, /You are an Orca worker/);
	assert.ok(text.length < 1_200, `kept short: ${text.length} chars`);
});

test("an Orca worker is reminded it still orchestrates its own task with subagents", () => {
	const text = delegationGuide({ orca: true, worker: true }) ?? "";
	assert.match(text, /You are an Orca worker/);
	assert.match(text, /keep using Gentle subagents/);
});
