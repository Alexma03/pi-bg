// Pure watchdog detectors plus the read-only Git inventory used by the
// coordinator. The extension persists only small detector state under
// PI_BG_STATE_DIR; this module never writes to a worker worktree.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { SETTLED_OUTCOMES } from "./fleet.ts";

const execFileAsync = promisify(execFile);
const MINUTE = 60_000;

export interface WatchdogConfig {
	enabled: boolean;
	cadenceMs: number;
	stallMs: number;
	loopMs: number;
	waitRepeatCount: number;
	cooldownMs: number;
	releaseGraceMs: number;
	/** Overrides per-task spec surfaces when non-empty. */
	scopeGlobs: string[];
}

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
	enabled: true,
	cadenceMs: 2 * MINUTE,
	stallMs: 10 * MINUTE,
	loopMs: 6 * MINUTE,
	waitRepeatCount: 3,
	cooldownMs: 30 * MINUTE,
	releaseGraceMs: 3 * MINUTE,
	scopeGlobs: [],
};

/** Merge persisted/tool configuration while clamping unsafe or unreasonable values. */
export function normalizeWatchdogConfig(value: unknown, base: WatchdogConfig = DEFAULT_WATCHDOG_CONFIG): WatchdogConfig {
	const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const bounded = (key: string, fallback: number, min: number, max: number) => {
		const candidate = raw[key];
		return typeof candidate === "number" && Number.isFinite(candidate) ? Math.round(Math.max(min, Math.min(max, candidate))) : fallback;
	};
	const globs = Array.isArray(raw.scopeGlobs) ? raw.scopeGlobs.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, 200)).filter(Boolean).slice(0, 100) : base.scopeGlobs;
	return {
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : base.enabled,
		cadenceMs: bounded("cadenceMs", base.cadenceMs, MINUTE, 30 * MINUTE),
		stallMs: bounded("stallMs", base.stallMs, MINUTE, 6 * 60 * MINUTE),
		loopMs: bounded("loopMs", base.loopMs, MINUTE, 6 * 60 * MINUTE),
		waitRepeatCount: bounded("waitRepeatCount", base.waitRepeatCount, 2, 10),
		cooldownMs: bounded("cooldownMs", base.cooldownMs, MINUTE, 24 * 60 * MINUTE),
		releaseGraceMs: bounded("releaseGraceMs", base.releaseGraceMs, MINUTE, 24 * 60 * MINUTE),
		scopeGlobs: globs,
	};
}

export type WatchdogKind = "scope" | "stall" | "loop" | "prompt" | "finished";

export interface WatchdogSample {
	dispatchId: string;
	title: string;
	taskSpec: string;
	activity: string;
	outcome: string;
	liveness: string;
	ownership: string;
	nextAction: string;
	terminalState: string;
	activityAt: number | null;
	tail: string[];
	/** Git paths changed from merge-base origin/main (committed and uncommitted). */
	changedPaths?: string[];
	/** Time since an accepted worker completion, if available. */
	settledForMs?: number;
	requiresInput?: boolean;
	pendingQuestion?: string;
	questionOptions?: string[];
}

export interface WatchdogFinding {
	key: string;
	kind: WatchdogKind;
	dispatchId: string;
	title: string;
	detail: string;
	sinceMs?: number;
}

interface ScreenTrack { fingerprint: string; since: number }
interface WaitTrack { since: number; count: number; lastSeen: number; progress: string; activityAt: number | null }
export interface WatchdogState {
	active: string[];
	lastNotified: Record<string, number>;
	screens: Record<string, ScreenTrack>;
	waits: Record<string, WaitTrack>;
}

export function initialWatchdogState(): WatchdogState {
	return { active: [], lastNotified: {}, screens: {}, waits: {} };
}

/** Read a spec's explicit Allowed edit surfaces section. Undefined means no policy was supplied. */
export function parseAllowedEditSurfaces(spec: string): string[] | undefined {
	const lines = spec.split(/\r?\n/);
	const index = lines.findIndex((line) => /\ballowed\s+edit\s+surfaces\b/i.test(line));
	if (index < 0) return undefined;
	const collected: string[] = [];
	for (let i = index; i < lines.length; i++) {
		const line = lines[i].trim();
		if (i > index && /^#{1,6}\s|^\*\*[^*]+:\*\*/.test(line)) break;
		const content = i === index ? (line.split(/allowed\s+edit\s+surfaces\s*:?/i).slice(1).join(":") ?? "") : line;
		const lower = content.toLowerCase();
		if (/\b(everything|all files|entire worktree|whole worktree)\b/.test(lower)) collected.push("**/*");
		for (const match of content.matchAll(/`([^`]+)`/g)) {
			const path = normalizeGlob(match[1]);
			if (path) collected.push(path);
		}
		if (!content.includes("`") && /^[-*]\s+/.test(content)) {
			const item = content.replace(/^[-*]\s+/, "").trim();
			if (/^(?:!?[\w./*-]+)(?:\s*,\s*(?:!?[\w./*-]+))*$/.test(item)) collected.push(...item.split(/\s*,\s*/).map(normalizeGlob));
		}
	}
	const unique = [...new Set(collected.filter(Boolean))];
	return unique.length ? unique : [];
}

function normalizeGlob(value: string): string {
	return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "") || "";
}

function globRegex(glob: string): RegExp {
	let source = "^";
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i];
		if (char === "*" && glob[i + 1] === "*") {
			i++;
			if (glob[i + 1] === "/") {
				i++;
				source += "(?:.*/)?";
			} else source += ".*";
		} else if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
	}
	return new RegExp(`${source}$`);
}

/** Whether a repository-relative path is in the spec's allowed surfaces. */
export function matchesScope(path: string, allowed: string[]): boolean {
	const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
	const exclusions = allowed.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
	if (exclusions.some((pattern) => globRegex(normalizeGlob(pattern)).test(normalized))) return false;
	const inclusions = allowed.filter((pattern) => !pattern.startsWith("!"));
	return inclusions.length === 0 || inclusions.some((pattern) => globRegex(normalizeGlob(pattern)).test(normalized));
}

/** Normalize screen content without clocks, footer counters, card timers, or spinner frames. */
function normalizedScreen(tail: string[]): string {
	const useful = tail.slice(-40).filter((line) => {
		const trimmed = line.trim();
		if (!trimmed) return false;
		if (/^─{2,}.*(?:Working|Thinking|Tool|Waiting).*─{2,}$/i.test(trimmed)) return false;
		if (/^\s*(?:⏵\s+\d+\s+(?:tarea|task)|orca\s+(?:◉|◆|⚠))/i.test(trimmed)) return false;
		if (/\b\d+(?:\.\d+)?%\/\d+(?:\.\d+)?[kM]\b/.test(trimmed)) return false;
		if (/^│\s*(?:⏵|✔|✖|■)\s/.test(trimmed)) return false;
		return true;
	});
	return useful.map((line) => line.replace(/\s*\(\+\d+ lines?\)\s*$/, "").replace(/\s+/g, " ").trim()).join("\n");
}

function digest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** A stable, non-reversible screen fingerprint for state persistence. */
export function screenFingerprint(tail: string[]): string {
	const normalized = normalizedScreen(tail);
	return normalized ? digest(normalized) : "";
}

const WAITING = /\bwaiting\s+(?:for|on)\s+([a-z][a-z0-9 _./:-]{1,80})/i;

function progressFingerprint(tail: string[]): string {
	const progress = normalizedScreen(tail).split("\n").filter((line) => !WAITING.test(line)).join("\n");
	return progress ? digest(progress) : "";
}

function waitingPhrase(tail: string[]): { phrase: string; occurrences: number } | undefined {
	const matches = tail.slice(-20).map((line) => WAITING.exec(line)?.[1]?.replace(/[.…]+$/, "").replace(/\s+/g, " ").trim().toLowerCase()).filter((v): v is string => Boolean(v));
	if (!matches.length) return undefined;
	const phrase = matches.at(-1)!;
	return { phrase, occurrences: matches.length };
}

export interface WaitingQuestion {
	source: "picker" | "approval" | "orca-ask" | "plain";
	text: string;
	options: string[];
}

const APPROVAL = /(?:\ballow(?:ed)?\b[^\n?]{0,100}\?|\bapprove\b[^\n?]{0,100}\?|\bconfirm\b[^\n?]{0,100}\?|\[\s*y\s*\/\s*n\s*\]|\(\s*y\s*\/\s*n\s*\)|press\s+(?:enter|any key)\s+to\s+(?:continue|confirm))/i;
const PICKER_HINT = /(?:↑↓|up\s*\/\s*down).*\b(?:enter|select)\b/i;
const OPTION = /^(?:❯|›|>|○|◯|●|◉|□|\d+[.)]|[-*])\s*(.+)$/;

function screenText(line: string): string {
	return line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/^\s*[│║]\s?/, "").replace(/\s*[│║]\s*$/, "").trim();
}

function contentIndent(line: string): number {
	const content = line.replace(/^\s*[│║]\s?/, "");
	return (content.match(/^\s*/) ?? [""])[0].length;
}

function optionRows(lines: string[]): string[] {
	const result: string[] = [];
	for (const raw of lines) {
		const line = screenText(raw);
		const marked = OPTION.exec(line);
		if (marked) result.push(marked[1].trim());
	}
	return [...new Set(result.filter(Boolean))];
}

function questionOptions(text: string, lines: string[]): string[] {
	const explicit = optionRows(lines);
	if (explicit.length) return explicit;
	const labeled = [...lines].reverse().map(screenText).find((line) => /^options?\s*:/i.test(line));
	if (labeled) {
		const body = labeled.replace(/^options?\s*:/i, "").trim();
		if (body) return body.split(/\s*,\s*|\s+or\s+|\s+and\s+/i).map((option) => option.trim()).filter(Boolean);
	}
	const match = /,?\s+([\w.-]+)\s+or\s+([\w.-]+)\?\s*$/i.exec(text);
	if (match) return [match[1], match[2]];
	return [];
}

function pickerQuestion(tail: string[]): WaitingQuestion | undefined {
	const marker = tail.findLastIndex((line) => PICKER_HINT.test(screenText(line)));
	if (marker < 0) return undefined;
	const start = Math.max(0, marker - 20);
	const block = tail.slice(start, marker);
	const optionStart = block.findIndex((line) => OPTION.test(screenText(line)));
	if (optionStart < 0) return undefined;
	const candidates = block.slice(0, optionStart).map(screenText).filter((line) => line && !/^╭|^╰|^─+$/.test(line));
	const text = [...candidates].reverse().find((line) => line.includes("?")) ?? candidates.at(-1);
	if (!text) return undefined;
	const options: string[] = [];
	const first = screenText(block[optionStart]);
	const firstMatch = OPTION.exec(first);
	if (firstMatch) options.push(firstMatch[1].trim());
	const indent = contentIndent(block[optionStart]);
	for (const raw of block.slice(optionStart + 1)) {
		const line = screenText(raw);
		if (!line || /^╭|^╰|^─+$/.test(line)) continue;
		const marked = OPTION.exec(line);
		if (marked) options.push(marked[1].trim());
		else {
			const rawIndent = contentIndent(raw);
			if (rawIndent === indent + 2) options.push(line);
		}
	}
	return { source: "picker", text, options: [...new Set(options.filter(Boolean))] };
}

/** Extract the question and choices from a picker, approval prompt, Orca ask or idle plain-text question. */
export function extractWaitingQuestion(tail: string[], input: { activity: string; outcome: string; requiresInput?: boolean; pendingQuestion?: string; questionOptions?: string[] }): WaitingQuestion | undefined {
	const pending = input.pendingQuestion?.trim();
	if (pending) return { source: "orca-ask", text: pending, options: [...(input.questionOptions ?? [])] };
	const picker = pickerQuestion(tail);
	if (picker) return input.requiresInput ? { ...picker, source: "orca-ask" } : picker;
	const approval = [...tail].reverse().map(screenText).find((line) => line && APPROVAL.test(line));
	if (approval) {
		const options = optionRows(tail.slice(Math.max(0, tail.lastIndexOf(approval) - 8)));
		return { source: "approval", text: approval, options: options.length ? options : /\[\s*y\s*\/\s*n\s*\]|\(\s*y\s*\/\s*n\s*\)/i.test(approval) ? ["Yes", "No"] : [] };
	}
	const canAsk = input.requiresInput || ((input.activity === "done" || input.activity === "idle") && input.outcome === "in_progress");
	if (canAsk) {
		const plain = [...tail].reverse().map(screenText).find((line) => /^(?:question|ask)\s*[:：]/i.test(line) || (line.length >= 12 && line.endsWith("?") && !/^[$>#]/.test(line)));
		if (plain) {
			const text = plain.replace(/^(?:question|ask)\s*[:：]\s*/i, "");
			return { source: input.requiresInput ? "orca-ask" : "plain", text, options: input.questionOptions?.length ? [...input.questionOptions] : questionOptions(text, tail) };
		}
	}
	const waitingInput = [...tail].reverse().map(screenText).find((line) => /waiting for (?:your )?(?:input|approval)/i.test(line));
	if (waitingInput) return { source: "orca-ask", text: waitingInput, options: [...(input.questionOptions ?? [])] };
	if (input.requiresInput) return { source: "orca-ask", text: "Orca ask is pending; question text is not present in the worker screen.", options: [...(input.questionOptions ?? [])] };
	return undefined;
}

function makeFinding(sample: WatchdogSample, kind: WatchdogKind, suffix: string, detail: string, sinceMs?: number): WatchdogFinding {
	return { key: `${kind}:${sample.dispatchId}:${suffix}`, kind, dispatchId: sample.dispatchId, title: sample.title || sample.dispatchId, detail, ...(sinceMs !== undefined ? { sinceMs } : {}) };
}

/** Evaluate one bounded watchdog snapshot and emit only new, non-cooled findings. */
export function evaluateWatchdog(previous: WatchdogState, samples: WatchdogSample[], now: number, config: WatchdogConfig = DEFAULT_WATCHDOG_CONFIG): { state: WatchdogState; findings: WatchdogFinding[] } {
	if (!config.enabled) return { state: { ...previous, active: [], screens: {}, waits: {} }, findings: [] };
	const state: WatchdogState = { active: [], lastNotified: { ...previous.lastNotified }, screens: { ...previous.screens }, waits: { ...previous.waits } };
	const current: WatchdogFinding[] = [];
	const seenDispatches = new Set(samples.map((sample) => sample.dispatchId));
	for (const id of Object.keys(state.screens)) if (!seenDispatches.has(id)) delete state.screens[id];
	for (const id of Object.keys(state.waits)) if (!seenDispatches.has(id)) delete state.waits[id];

	for (const sample of samples) {
		if (sample.ownership === "user_owned") {
			delete state.screens[sample.dispatchId];
			delete state.waits[sample.dispatchId];
			continue;
		}
		const configured = config.scopeGlobs.length ? config.scopeGlobs : parseAllowedEditSurfaces(sample.taskSpec);
		if (configured?.length) {
			if (sample.changedPaths === undefined) current.push(makeFinding(sample, "scope", "unavailable", "could not read changed files against merge-base origin/main"));
			else for (const path of sample.changedPaths) if (!matchesScope(path, configured)) current.push(makeFinding(sample, "scope", digest(path), `changed file outside allowed surfaces: ${path}`));
		}

		const screen = screenFingerprint(sample.tail);
		if (sample.activity === "working" && screen) {
			const old = previous.screens[sample.dispatchId];
			let since = !old || old.fingerprint !== screen ? now : old.since;
			if (old?.fingerprint === screen && sample.activityAt !== null && sample.activityAt > since && sample.activityAt <= now) since = sample.activityAt;
			state.screens[sample.dispatchId] = { fingerprint: screen, since };
			const elapsed = now - since;
			if (elapsed >= config.stallMs) current.push(makeFinding(sample, "stall", "unchanged-screen", `screen unchanged while activity remains working for ${Math.round(elapsed / MINUTE)} minutes`, elapsed));
		} else delete state.screens[sample.dispatchId];

		const waiting = waitingPhrase(sample.tail);
		if (waiting) {
			const old = previous.waits[sample.dispatchId];
			const progress = progressFingerprint(sample.tail);
			const statusAdvanced = Boolean(old && sample.activityAt !== null && old.activityAt !== null && sample.activityAt > old.activityAt);
			const continuing = old && now - old.lastSeen <= config.loopMs && old.progress === progress && !statusAdvanced;
			const track: WaitTrack = continuing
				? { since: old.since, count: old.count + 1, lastSeen: now, progress, activityAt: sample.activityAt }
				: { since: now, count: 1, lastSeen: now, progress, activityAt: sample.activityAt };
			state.waits[sample.dispatchId] = track;
			if (waiting.occurrences >= config.waitRepeatCount || track.count >= config.waitRepeatCount) {
				current.push(makeFinding(sample, "loop", "repeated-wait", `repeated waiting status without visible progress (latest: waiting on ${waiting.phrase})`, now - track.since));
			}
		} else delete state.waits[sample.dispatchId];

		const question = extractWaitingQuestion(sample.tail, { activity: sample.activity, outcome: sample.outcome, requiresInput: sample.requiresInput, pendingQuestion: sample.pendingQuestion, questionOptions: sample.questionOptions });
		if (question) {
			const options = question.options.length ? question.options.join(", ") : "not shown";
			current.push(makeFinding(sample, "prompt", digest(`${question.source}\0${question.text}`), `worker is waiting for an answer (${question.source}) · Question: ${question.text} · Options: ${options}`));
		}

		const closureDebt = (SETTLED_OUTCOMES.has(sample.outcome) && sample.nextAction === "release" && (sample.settledForMs ?? 0) >= config.releaseGraceMs) || (sample.liveness === "exited" && sample.nextAction !== "release" && sample.terminalState !== "released");
		if (closureDebt) current.push(makeFinding(sample, "finished", "not-closed", `worker finished/exited without terminal release (terminal ${sample.terminalState || "unknown"})`));
	}

	const currentKeys = new Set(current.map((finding) => finding.key));
	const oldActive = new Set(previous.active);
	const findings: WatchdogFinding[] = [];
	for (const finding of current) {
		state.active.push(finding.key);
		if (oldActive.has(finding.key)) continue;
		const last = state.lastNotified[finding.key];
		if (last !== undefined && now - last < config.cooldownMs) continue;
		findings.push(finding);
		state.lastNotified[finding.key] = now;
	}
	// Keep the ledger bounded; recent entries are the only ones relevant to cooldown.
	for (const [key, at] of Object.entries(state.lastNotified)) if (now - at > 24 * 60 * 60_000) delete state.lastNotified[key];
	state.active = [...currentKeys];
	return { state, findings };
}

/** Read changed paths from merge-base origin/main through HEAD, the index/worktree, and untracked files. */
export async function gitChangedFiles(worktreePath: string, baseRef = "origin/main"): Promise<string[]> {
	const options = { cwd: worktreePath, encoding: "utf8" as const, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 };
	const run = async (args: string[]): Promise<string> => {
		const result = await execFileAsync("git", args, options);
		return String(result.stdout ?? "");
	};
	const mergeBase = (await run(["merge-base", baseRef, "HEAD"])).trim();
	if (!mergeBase) throw new Error(`no merge-base between ${baseRef} and HEAD`);
	const [committed, working, untracked] = await Promise.all([
		run(["diff", "--name-only", "-z", `${mergeBase}..HEAD`]),
		run(["diff", "--name-only", "-z", "HEAD"]),
		run(["ls-files", "--others", "--exclude-standard", "-z"]),
	]);
	return [...new Set([committed, working, untracked].flatMap((output) => output.split("\0").map((path) => path.replace(/\\/g, "/")).filter(Boolean)))].sort();
}
