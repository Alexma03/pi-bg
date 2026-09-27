// What a worker is doing right now, read from the tail of its terminal
// (`orca orchestration worker-read`). Orca has no structured transcript for
// every agent, so this is a display-only heuristic over the rendered TUI:
// drop chrome, then prefer a running background task, then the last tool
// action, then the last line the agent wrote. Pure.

const BOX = /^[╭│╰]/;
const RULE = /^[\s─━═-]+$/;
const TOOL_NAME = /^\s?([a-z][a-z0-9_]*)$/;
const ACTION = /^(read|edit|write|grep|find|ls) \S/;
const CHROME = [/^✿ /, /^ctrl\+\w to /i, /^↳ /, /^\s*=== TASK ===\s*$/];

function isChrome(line: string): boolean {
	return !line.trim() || BOX.test(line) || RULE.test(line) || CHROME.some((re) => re.test(line));
}

function tidy(text: string): string {
	return text
		.replace(/\s*\(\+\d+ lines?\)\s*$/, "")
		.replace(/\s*\(timeout \d+s\)\s*$/, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** The latest activity of a worker from its terminal tail, or undefined. */
export function lastActivity(tail: string[]): string | undefined {
	// 1. A background task the worker is waiting on (its own pi-bg card).
	for (let i = tail.length - 1; i >= 0; i--) {
		const m = /^│\s*▸\s+(.*?)\s*│\s*$/.exec(tail[i]);
		if (m && m[1]) return `⏵ ${tidy(m[1])}`;
	}
	const lines = tail.filter((l) => !isChrome(l));
	// 2. The last tool action.
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (line.startsWith("$ ")) return tidy(line);
		if (ACTION.test(line)) return tidy(line);
		const tool = TOOL_NAME.exec(line);
		if (tool) {
			const next = lines[i + 1] ? tidy(lines[i + 1]) : "";
			return next ? `${tool[1]} · ${next}` : tool[1];
		}
	}
	// 3. The last line the agent wrote.
	const last = lines[lines.length - 1];
	return last ? tidy(last) : undefined;
}

/** Activity text without running clocks, so a ticking timer is not a change. */
export function activityKey(text: string): string {
	return text.replace(/\b\d+h\d+m\b|\b\d+m\d+s\b|\b\d+(\.\d+)?s\b|\b\d+m\b/g, "#").trim();
}

/** The worker waits on one of its own background tasks: quiet is expected. */
export function waitingOnBackground(text: string): boolean {
	return text.startsWith("⏵ ");
}

export interface ActivitySeen {
	text: string;
	/** When the activity (without clocks) last changed, ms epoch. */
	since: number;
}

/** Fold a new reading into the previous one; `since` moves only on a real change. */
export function nextActivity(prev: ActivitySeen | undefined, text: string, now: number): ActivitySeen {
	if (prev && activityKey(prev.text) === activityKey(text)) return { text, since: prev.since };
	return { text, since: now };
}
