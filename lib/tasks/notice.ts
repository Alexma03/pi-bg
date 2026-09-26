// Model-facing text for background task notices. Pure.

import { redact } from "../redact.ts";
import { clip, formatDuration, sanitizeTerminal } from "../text.ts";

export type NoticeKind = "exit" | "match" | "timeout" | "error";

export interface TaskNotice {
	kind: NoticeKind;
	id: string;
	label: string;
	command: string;
	logPath: string;
	durationMs: number;
	exitCode: number | null;
	signal: string | null;
	/** Output lines to show: last lines on exit, matching lines on match. */
	lines: string[];
	/** Task keeps running after this notice (each-mode or keepRunning). */
	stillRunning: boolean;
	/** Extra context, e.g. "watch budget exhausted". */
	note?: string;
	pattern?: string;
	eventNumber?: number;
	maxEvents?: number;
}

const clean = (text: string): string => redact(sanitizeTerminal(text));

export function noticeHeadline(n: TaskNotice): string {
	const name = n.label && n.label !== n.id ? `${n.id} "${clip(clean(n.label), 60)}"` : n.id;
	const after = formatDuration(n.durationMs);
	switch (n.kind) {
		case "exit": {
			const how = n.signal ? `was killed by ${n.signal}` : n.exitCode === 0 ? "exited 0" : `FAILED with exit ${n.exitCode}`;
			return `task ${name} ${how} after ${after}`;
		}
		case "timeout":
			return `task ${name} hit its deadline after ${after} and was stopped`;
		case "error":
			return `task ${name} could not run`;
		case "match": {
			const counter = n.maxEvents && n.maxEvents > 1 ? ` (event ${n.eventNumber}/${n.maxEvents})` : "";
			return `task ${name} matched /${clip(n.pattern ?? "", 80)}/${counter} after ${after}${n.stillRunning ? " · still running" : " · stopped"}`;
		}
	}
}

export function formatNotice(n: TaskNotice, maxChars = 2_400): string {
	const out: string[] = [noticeHeadline(n)];
	out.push(`  $ ${clip(clean(n.command), 200)}`);
	if (n.note) out.push(`  ${n.note}`);
	if (n.lines.length) {
		out.push(n.kind === "match" ? "  matching lines:" : `  last ${n.lines.length} line${n.lines.length === 1 ? "" : "s"}:`);
		for (const line of n.lines) out.push(`  │ ${clip(clean(line), 400)}`);
	}
	out.push(`  log: ${n.logPath}${n.stillRunning ? ` · bg_tail id=${n.id} · bg_cancel id=${n.id}` : ""}`);
	return clip(out.join("\n"), maxChars);
}

/** One message for several notices that settled together. */
export function formatNotices(notices: TaskNotice[], maxChars = 8_000): string {
	const header = notices.length === 1 ? "pi-bg:" : `pi-bg: ${notices.length} background task updates`;
	const perNotice = Math.max(600, Math.floor((maxChars - 100) / Math.max(1, notices.length)));
	return clip([header, ...notices.map((n) => formatNotice(n, perNotice))].join("\n"), maxChars);
}
