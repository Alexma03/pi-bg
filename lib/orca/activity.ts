// What a worker is doing right now, read from the tail of its terminal
// (`orca orchestration worker-read`). Orca has no structured transcript for
// every agent, so this is a display-only heuristic over the rendered TUI:
// drop chrome, then prefer a running background task, then the last tool
// action (described in words while its arguments are still being written),
// then the last line the agent wrote. Pure.

const BOX = /^[╭│╰]/;
const RULE = /^[\s─━═-]+$/;
const TOOL_NAME = /^ ([a-z][a-z0-9_]*)$/;
const ACTION = /^(read|edit|write|grep|find|ls) \S/;
// A tool call whose arguments are still being written: "write ...", "$ ...".
const PENDING = /^(\$|read|edit|write|grep|find|ls) (?:\.\.\.|…)\s*$/;
const PENDING_WORDS: Record<string, string> = {
	$: "preparando un comando",
	read: "leyendo un fichero",
	edit: "editando un fichero",
	write: "escribiendo un fichero",
	grep: "buscando en ficheros",
	find: "buscando ficheros",
	ls: "listando un directorio",
};
// What the agent says is written with one leading space, unlike tool output.
const NARRATION = /^ \S/;
// Gentle Shell chrome, plus Pi's default "── ⠦ Working ──" spinner rule.
const CHROME = [/^✿ /, /^ctrl\+\w to /i, /^↳ /, /^\s*=== TASK ===\s*$/, /^─{2,} .* ─{2,}$/];

function isChrome(line: string): boolean {
	return !line.trim() || BOX.test(line) || RULE.test(line) || CHROME.some((re) => re.test(line));
}

const PI_CONTEXT_USAGE = /\d+(\.\d+)?%\/\d+(\.\d+)?[kM]\b/;

/**
 * Pi's default TUI ends with the editor between two full-width rules, then a
 * footer (cwd, token stats, status segments) written flush left, while the
 * agent's own lines are indented. Cut from the editor down.
 */
function withoutPiFooter(tail: string[]): string[] {
	let last = -1;
	for (let i = tail.length - 1; i >= 0; i--) {
		if (RULE.test(tail[i]) && tail[i].trim()) {
			last = i;
			break;
		}
	}
	if (last < 0) return tail;
	const footer = tail.slice(last + 1).filter((l) => l.trim());
	if (footer.length > 6 || footer.some((l) => /^\s/.test(l) || BOX.test(l))) return tail;
	// Pi's footer always has the context usage ("2.4%/700k"); anything else is output.
	if (!footer.some((l) => PI_CONTEXT_USAGE.test(l))) return tail;
	for (let i = last - 1; i >= 0 && last - i <= 12; i--) {
		if (RULE.test(tail[i]) && tail[i].trim()) return tail.slice(0, i);
	}
	return tail;
}

function tidy(text: string): string {
	return text
		.replace(/^\$ # pi-bg bg\d+ \([^)]*\): /, "$ ")
		.replace(/\s*\(\+\d+ lines?\)\s*$/, "")
		.replace(/\s*\(timeout \d+s\)\s*$/, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** The latest activity of a worker from its terminal tail, or undefined. */
export function lastActivity(tail: string[]): string | undefined {
	// 1. Its own pi-bg card: a foreground command it runs ("$", with its live
	//    last output line) or a background task it waits on ("▸").
	// Older formats ("$ bgN bash · …", "▸ bgN …", "⏵ en segundo plano · …") are still read.
	for (let i = tail.length - 1; i >= 0; i--) {
		const fg = /^│\s*\$\s+(?:comando en curso|bg\d+ bash) · (.*?)\s*│\s*$/.exec(tail[i]);
		if (fg && fg[1]) return `$ ${tidy(fg[1])}`;
		const m = /^│\s*(?:⏵ en segundo plano ·|▸\s+bg\d+|⏵)\s+(.*?)\s*│\s*$/.exec(tail[i]);
		if (m && m[1]) return `⏵ ${tidy(m[1])}`;
	}
	const lines = withoutPiFooter(tail).filter((l) => !isChrome(l));
	// 2. The last tool action.
	for (let i = lines.length - 1; i >= 0; i--) {
		// Pi's default TUI indents tool lines by one space.
		const line = lines[i].replace(/^ (?=\$ |(?:read|edit|write|grep|find|ls) \S)/, "");
		const pending = PENDING.exec(line);
		if (pending) {
			// Say it in words, plus what the agent said just before (back to its previous tool call).
			let said = "";
			for (let j = i - 1; j >= 0; j--) {
				const prev = lines[j].replace(/^ (?=\$ |(?:read|edit|write|grep|find|ls) \S)/, "");
				if (prev.startsWith("$ ") || ACTION.test(prev) || TOOL_NAME.test(prev)) break;
				if (NARRATION.test(lines[j])) {
					said = tidy(lines[j]);
					break;
				}
			}
			const words = PENDING_WORDS[pending[1]];
			return said ? `${words} · ${said.length > 160 ? `${said.slice(0, 159)}…` : said}` : words;
		}
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
export function nextActivity(prev: ActivitySeen | undefined, text: string, now: number, activityAt?: number | null): ActivitySeen {
	let since = prev && activityKey(prev.text) === activityKey(text) ? prev.since : now;
	// Orca may report a recent heartbeat/status from this Dispatch even when
	// its visible screen has not changed (common for long-running operators).
	if (activityAt !== null && activityAt !== undefined && activityAt <= now && activityAt > since) since = activityAt;
	return { text, since };
}
