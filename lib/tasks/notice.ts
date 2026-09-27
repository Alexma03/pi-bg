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
	/** An until-watch stopped the task on this match. */
	stopped?: boolean;
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
			return `task ${name} matched /${clip(n.pattern ?? "", 80)}/${counter} after ${after}${n.stillRunning ? " · still running" : n.stopped ? " · stopped" : " · before it exited"}`;
		}
	}
}

export function formatNotice(n: TaskNotice, maxChars = 2_400): string {
	const out: string[] = [noticeHeadline(n)];
	out.push(`  $ ${clip(clean(n.command), 200)}`);
	if (n.note) out.push(`  ${n.note}`);
	if (n.lines.length) {
		out.push(n.kind === "match" ? "  matching lines:" : `  last ${n.lines.length} line${n.lines.length === 1 ? "" : "s"}:`);
		// Redact the joined lines so multiline secrets (PEM blocks) still match.
		for (const line of clean(n.lines.join("\n")).split("\n")) out.push(`  │ ${clip(line, 400)}`);
	}
	out.push(`  log: ${n.logPath}${n.stillRunning ? ` · bg_tail id=${n.id} · bg_cancel id=${n.id}` : ""}`);
	return clip(out.join("\n"), maxChars);
}

/** One message for several notices that settled together. */
export function formatNotices(notices: TaskNotice[], maxChars = 8_000): string {
	if (notices.length === 1) return clip(`pi-bg:\n${formatNotice(notices[0], maxChars - 10)}`, maxChars);
	// Every task keeps its headline (status, exit code) before any detail, so a
	// failure is never clipped away when many tasks settle together.
	const headlines = notices.map((n) => `- ${noticeHeadline(n)}`);
	const head = [`pi-bg: ${notices.length} background task updates`, ...headlines].join("\n");
	const room = maxChars - head.length - 1;
	if (room < 300) return clip(head, maxChars) + "\nDetails: bg_status / bg_tail.";
	const perNotice = Math.max(300, Math.floor(room / notices.length));
	const details: string[] = [];
	let used = 0;
	for (const n of notices) {
		const text = formatNotice(n, perNotice);
		if (used + text.length + 1 > room) {
			details.push(`… details for ${notices.length - details.length} more: bg_status / bg_tail.`);
			break;
		}
		details.push(text);
		used += text.length + 1;
	}
	return `${head}\n${details.join("\n")}`;
}
