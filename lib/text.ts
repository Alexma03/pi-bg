// Small text helpers shared by task notices and Orca deliveries. Everything
// that reaches the model or the terminal goes through `clip` (bounded size)
// and `sanitizeTerminal` (no escape sequences from child output).

/** Strip ANSI escape sequences and C0 controls except newline and tab. */
export function sanitizeTerminal(text: string): string {
	return text
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b[@-_]/g, "")
		.replace(/\r(?!\n)/g, "\n")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

/** Keep at most `max` characters, marking the cut with the dropped count. */
export function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	const dropped = text.length - max;
	return `${text.slice(0, max)}… [${dropped} more chars]`;
}

/** Keep the last `max` characters, marking the cut at the start. */
export function clipStart(text: string, max: number): string {
	if (text.length <= max) return text;
	const dropped = text.length - max;
	return `[${dropped} earlier chars] …${text.slice(text.length - max)}`;
}

/** The last `count` lines of `text`, ignoring one trailing newline. */
export function lastLines(text: string, count: number): string[] {
	if (count <= 0 || text.length === 0) return [];
	const lines = text.replace(/\n$/, "").split("\n");
	return lines.slice(Math.max(0, lines.length - count));
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** Shorten an opaque id for the footer: `run_8da5785a70be` -> `run_8da5`. */
export function shortId(id: string, keep = 4): string {
	const underscore = id.indexOf("_");
	if (underscore < 0) return id.slice(0, keep + 4);
	return id.slice(0, underscore + 1 + keep);
}
