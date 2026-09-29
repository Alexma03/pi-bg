import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mustWake } from "../lib/orca/fleet-format.ts";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WATCHDOG_CONFIG, evaluateWatchdog, extractWaitingQuestion, gitChangedFiles, initialWatchdogState, matchesScope, parseAllowedEditSurfaces, type WatchdogSample } from "../lib/orca/watchdog.ts";

const MIN = 60_000;
const sample = (extra: Partial<WatchdogSample> = {}): WatchdogSample => ({
	dispatchId: "ctx_a", title: "worker A", taskSpec: "Allowed edit surfaces:\n- `src/**`", activity: "working", outcome: "in_progress", liveness: "live", ownership: "owned", nextAction: "none", terminalState: "active", activityAt: null, tail: ["Still implementing the parser."], changedPaths: [],
	...extra,
});

function scan(previous: ReturnType<typeof initialWatchdogState>, inputs: WatchdogSample[], now: number, config = DEFAULT_WATCHDOG_CONFIG) {
	return evaluateWatchdog(previous, inputs, now, config);
}

test("allowed surfaces parse from a spec and match nested globs", () => {
	const allowed = parseAllowedEditSurfaces("## Constraints\nAllowed edit surfaces:\n- `src/**/*.ts`\n- `README.md`\n\n## Acceptance\nRun tests.");
	assert.deepEqual(allowed, ["src/**/*.ts", "README.md"]);
	assert.equal(matchesScope("src/orca/watchdog.ts", allowed!), true);
	assert.equal(matchesScope("src/README.md", allowed!), false);
	assert.equal(matchesScope("docs/README.md", allowed!), false);
	assert.deepEqual(parseAllowedEditSurfaces("Allowed edit surfaces: everything inside this worktree is allowed."), ["**/*"]);
});

test("scope reports changed paths outside allowed surfaces only", () => {
	let result = scan(initialWatchdogState(), [sample({ changedPaths: ["src/index.ts", "docs/private.md"] })], 0);
	assert.deepEqual(result.findings.map((f) => f.kind), ["scope"]);
	assert.match(result.findings[0].detail, /docs\/private.md/);
	result = scan(result.state, [sample({ changedPaths: ["src/index.ts"] })], MIN);
	assert.deepEqual(result.findings, [], "an allowed-only worktree is fine and clears the old condition");
});

test("working screen unchanged past the threshold stalls, but recent status activity resets it", () => {
	const config = { ...DEFAULT_WATCHDOG_CONFIG, stallMs: 10 * MIN, cooldownMs: MIN };
	let result = scan(initialWatchdogState(), [sample()], 0, config);
	result = scan(result.state, [sample()], 11 * MIN, config);
	assert.deepEqual(result.findings.map((f) => f.kind), ["stall"]);
	let fresh = scan(initialWatchdogState(), [sample()], 0, config);
	fresh = scan(fresh.state, [sample({ activityAt: 10 * MIN })], 11 * MIN, config);
	assert.deepEqual(fresh.findings, [], "a dispatch heartbeat/status is real activity even if the screen is unchanged");
});

test("repeated waiting phrases across status churn identify a loop", () => {
	const config = { ...DEFAULT_WATCHDOG_CONFIG, loopMs: 5 * MIN, waitRepeatCount: 3 };
	let result = scan(initialWatchdogState(), [sample({ tail: ["Waiting for push completion…"] })], 0, config);
	result = scan(result.state, [sample({ tail: ["Waiting on verification…"] })], 2 * MIN, config);
	result = scan(result.state, [sample({ tail: ["Waiting for input…"] })], 4 * MIN, config);
	assert.deepEqual(result.findings.map((f) => f.kind).sort(), ["loop", "prompt"]);
	assert.match(result.findings.find((f) => f.kind === "loop")!.detail, /waiting/i);
});

test("a new tool/file-progress screen resets waiting-loop counts", () => {
	const config = { ...DEFAULT_WATCHDOG_CONFIG, loopMs: 5 * MIN, waitRepeatCount: 3 };
	let result = scan(initialWatchdogState(), [sample({ tail: ["Waiting for push completion…"] })], 0, config);
	result = scan(result.state, [sample({ tail: ["$ git status", "Waiting on verification…"] })], 2 * MIN, config);
	result = scan(result.state, [sample({ tail: ["$ git status", "Waiting for input…"] })], 4 * MIN, config);
	assert.equal(result.findings.some((finding) => finding.kind === "loop"), false, "the new command reset the loop episode");
	result = scan(result.state, [sample({ tail: ["$ git status", "Waiting for input…"] })], 6 * MIN, config);
	assert.equal(result.findings.some((finding) => finding.kind === "loop"), true, "repetition without further progress is reported");
});

async function screen(name: string): Promise<string[]> {
	return (await readFile(new URL(`./fixtures/watchdog/${name}`, import.meta.url), "utf8")).trimEnd().split(/\r?\n/);
}

test("Pi picker prompt includes the question and all selectable options from its screen", async () => {
	const question = extractWaitingQuestion(await screen("pi-picker.txt"), { activity: "blocked", outcome: "in_progress" });
	assert.deepEqual(question, { source: "picker", text: "Which test scope should I run?", options: ["Unit tests", "Unit plus integration tests", "Skip tests"] });
});

test("guarded shell approval includes the exact prompt and yes/no options", async () => {
	const tail = await screen("guarded-push.txt");
	const question = extractWaitingQuestion(tail, { activity: "blocked", outcome: "in_progress" });
	assert.deepEqual(question, { source: "approval", text: "Allow guarded git push? [y/N]", options: ["Yes", "No"] });
	const result = scan(initialWatchdogState(), [sample({ tail })], 0);
	assert.equal(result.findings[0].kind, "prompt");
	assert.match(result.findings[0].detail, /Allow guarded git push\? \[y\/N\]/);
	assert.match(result.findings[0].detail, /Yes.*No/);
});

test("Orca ask metadata and an idle worker's plain question wake with text and choices", async () => {
	const orcaAsk = extractWaitingQuestion([], { activity: "blocked", outcome: "in_progress", requiresInput: true, pendingQuestion: "May I change the public API?", questionOptions: ["Yes", "No"] });
	assert.deepEqual(orcaAsk, { source: "orca-ask", text: "May I change the public API?", options: ["Yes", "No"] });
	const fromScreen = extractWaitingQuestion(await screen("orca-ask.txt"), { activity: "blocked", outcome: "in_progress", requiresInput: true });
	assert.deepEqual(fromScreen, { source: "orca-ask", text: "Should I continue with the migration?", options: ["Continue", "Stop"] });
	const plain = extractWaitingQuestion(await screen("plain-question.txt"), { activity: "done", outcome: "in_progress" });
	assert.deepEqual(plain, { source: "plain", text: "Which base branch should I target, main or release?", options: ["main", "release"] });
	const result = scan(initialWatchdogState(), [sample({ activity: "done", tail: await screen("plain-question.txt") })], 0);
	assert.equal(result.findings[0].kind, "prompt");
	assert.match(result.findings[0].detail, /main, release/);
});

test("new watchdog findings bypass the ordinary fleet wake budget", () => {
	assert.equal(mustWake([{ kind: "prompt", dispatchId: "ctx_a", detail: "Question: proceed? Options: yes, no" }]), true);
	assert.equal(mustWake([{ kind: "scope", dispatchId: "ctx_a", detail: "outside scope" }]), true);
	assert.equal(mustWake([{ kind: "quiet", dispatchId: "ctx_a", detail: "stale activity" }]), false);
});

test("findings wake only on a new episode, respect cooldown, and can be disabled", () => {
	const config = { ...DEFAULT_WATCHDOG_CONFIG, cooldownMs: 5 * MIN };
	let result = scan(initialWatchdogState(), [sample({ tail: ["Allow guarded git push? [y/N]"] })], 0, config);
	assert.equal(result.findings.length, 1);
	result = scan(result.state, [sample({ tail: ["Allow guarded git push? [y/N]"] })], MIN, config);
	assert.deepEqual(result.findings, [], "an active finding is deduplicated");
	result = scan(result.state, [sample()], 2 * MIN, config);
	result = scan(result.state, [sample({ tail: ["Allow guarded git push? [y/N]"] })], 3 * MIN, config);
	assert.deepEqual(result.findings, [], "reopened finding is suppressed within cooldown");
	result = scan(result.state, [sample({ tail: ["Allow guarded git push? [y/N]"] })], 9 * MIN, { ...config, enabled: false });
	assert.deepEqual(result.findings, []);
});

test("settled or exited workers with closure debt are reported", () => {
	const result = scan(initialWatchdogState(), [sample({ outcome: "succeeded", nextAction: "release", terminalState: "release_unknown", settledForMs: 4 * MIN })], 4 * MIN);
	assert.deepEqual(result.findings.map((f) => f.kind), ["finished"]);
});

test("Git scope inventory includes committed, staged/worktree and untracked changes", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-bg-watchdog-git-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
	try {
		git("init", "-b", "main");
		await writeFile(join(root, "base.txt"), "base\n");
		git("add", "base.txt");
		git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base");
		git("branch", "origin/main");
		git("checkout", "-b", "feat/watchdog");
		await writeFile(join(root, "committed.md"), "committed\n");
		git("add", "committed.md");
		git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "feature");
		await writeFile(join(root, "base.txt"), "edited\n");
		await writeFile(join(root, "new-file.txt"), "untracked\n");
		assert.deepEqual(await gitChangedFiles(root), ["base.txt", "committed.md", "new-file.txt"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
