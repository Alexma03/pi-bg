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
