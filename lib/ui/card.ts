// The "Background · Orca" card shown above the editor, in the visual language
// of Gentle Shell cards (rounded frame, glyph title, tone by state). The model
// builder is pure and testable; the renderer only frames lines to a width.
//
// It is a plain widget (ctx.ui.setWidget), like gentle's Agents card: the
// Gentle fullscreen rail only paints its own fixed sections.

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { OrcaState } from "../orca/machine.ts";
import { isInProgress, summarize, summaryLine, type FleetState } from "../orca/fleet.ts";
import type { TaskSnapshot } from "../tasks/manager.ts";
import { formatDuration, shortId } from "../text.ts";

export type Tone = "info" | "success" | "warning" | "error";

export interface CardRow {
	text: string;
	tone?: Tone;
}

export interface CardModel {
	title: string;
	tone: Tone;
	rows: CardRow[];
	hint?: string;
}

export interface CardInput {
	now: number;
	tasks: TaskSnapshot[];
	/** Last output line per running task id (already sanitized). */
	lastLines?: Map<string, string>;
	orca?: OrcaState;
	fleet?: FleetState;
	fleetIncomplete?: boolean;
	collapsed?: boolean;
	/** Finished tasks stay visible this long. */
	finishedTtlMs?: number;
	maxRows?: number;
}

const GLYPH = "⏵";

export function buildCard(input: CardInput): CardModel | undefined {
	const ttl = input.finishedTtlMs ?? 60_000;
	const tasks = input.tasks.filter((t) => t.status === "running" || (t.endedAt !== undefined && input.now - t.endedAt < ttl));
	const orca = input.orca && input.orca.phase !== "off" ? input.orca : undefined;
	const fleet = orca && input.fleet ? input.fleet : undefined;
	const sum = fleet ? summarize(fleet, input.now) : undefined;
	if (!tasks.length && !orca) return undefined;

	const rows: CardRow[] = [];
	let tone: Tone = "info";
	const raise = (t: Tone) => {
		const order: Tone[] = ["info", "success", "warning", "error"];
		if (order.indexOf(t) > order.indexOf(tone)) tone = t;
	};

	for (const t of tasks) {
		const age = formatDuration((t.endedAt ?? input.now) - t.startedAt);
		const name = t.label !== t.id ? `${t.id} ${t.label}` : t.id;
		if (t.status === "running") {
			const last = input.lastLines?.get(t.id);
			rows.push({ text: `▸ ${name} · ${age}${last ? ` · ${last}` : ""}` });
		} else {
			const failed = t.status === "exited" ? t.exitCode !== 0 : t.status === "timeout" || t.status === "failed";
			rows.push({ text: `${failed ? "✖" : "✔"} ${name} · ${t.status}${t.exitCode !== null && t.status === "exited" ? ` ${t.exitCode}` : ""} · ${age}`, tone: failed ? "error" : "success" });
			if (failed) raise("warning");
		}
	}

	if (orca) {
		const run = orca.runId ? shortId(orca.runId) : "?";
		switch (orca.phase) {
			case "waiting":
				rows.push({ text: `⇄ orca ${run} · listening${orca.heartbeatsAcked ? ` · ${orca.heartbeatsAcked} heartbeats` : ""}` });
				break;
			case "pending":
			case "acking":
				rows.push({ text: `⇄ orca ${run} · delivery ${orca.pending?.id ?? ""} awaiting orca_ack${orca.pendingSince !== null ? ` · ${formatDuration(input.now - orca.pendingSince)}` : ""}`, tone: "warning" });
				raise("warning");
				break;
			case "backoff":
				rows.push({ text: `⇄ orca ${run} · ${orca.reason} · retry ${orca.retryAt !== null ? formatDuration(Math.max(0, orca.retryAt - input.now)) : "?"}`, tone: "warning" });
				raise("warning");
				break;
			case "fenced":
				rows.push({ text: `⇄ orca ${run} · ${orca.reason}`, tone: "error" });
				raise("error");
				break;
		}
	}

	if (fleet && sum) {
		rows.push({ text: `  fleet · ${summaryLine(sum)}${input.fleetIncomplete ? " · partial" : ""}` });
		for (const t of fleet.workers.values()) {
			const r = t.row;
			if (!isInProgress(r) && r.nextAction !== "release") continue;
			const title = fleet.tasks.get(r.taskId)?.title || r.taskId;
			const age = formatDuration(input.now - t.activitySince);
			let mark = "·";
			let rowTone: Tone | undefined;
			if (r.activity === "working") mark = "▸";
			else if (r.activity === "blocked") {
				mark = "⚠";
				rowTone = "warning";
			} else if (r.nextAction === "release") {
				mark = "↩";
			} else if (r.livenessReason === "stale_status" || ((r.activity === "done" || r.activity === "idle") && input.now - t.activitySince >= 3 * 60_000)) {
				mark = "⏸";
				rowTone = "warning";
			}
			if (rowTone) raise(rowTone);
			const state = r.nextAction === "release" ? "to release" : r.liveness === "live" ? `${r.activity} ${age}` : r.livenessReason || r.liveness;
			rows.push({ text: `  ${mark} ${title} · ${state}${r.ownership === "user_owned" ? " · human" : ""}`, ...(rowTone ? { tone: rowTone } : {}) });
		}
	}

	const running = tasks.filter((t) => t.status === "running").length;
	const titleParts = [running ? `${running} bg` : "", orca ? "orca" : ""].filter(Boolean);
	const max = input.maxRows ?? 8;
	const visible = input.collapsed ? rows.filter((r) => r.tone === "warning" || r.tone === "error").slice(0, 2) : rows.slice(0, max);
	const hidden = rows.length - visible.length;
	if (hidden > 0) visible.push({ text: `… ${hidden} more (/bg, orca_workers)` });
	return { title: `Background · ${titleParts.join(" · ") || "idle"}`, tone, rows: visible, hint: input.collapsed ? "collapsed" : undefined };
}

export interface CardTheme {
	fg(color: string, text: string): string;
}

const FRAME: Record<Tone, string> = { info: "border", success: "success", warning: "warning", error: "error" };
const TITLE: Record<Tone, string> = { info: "accent", success: "success", warning: "warning", error: "error" };
const ROW: Record<Tone, string> = { info: "text", success: "success", warning: "warning", error: "error" };

export function renderCardLines(model: CardModel, theme: CardTheme, width: number): string[] {
	const w = Math.max(10, Math.floor(width));
	const frame = (t: string) => theme.fg(FRAME[model.tone], t);
	const head = `${GLYPH} ${model.title}`;
	const hint = model.hint ? ` ${model.hint} ` : "";
	const titleSpace = w - 5 - visibleWidth(hint);
	const title = truncateToWidth(head, Math.max(1, titleSpace), "…");
	const fill = "─".repeat(Math.max(0, w - 5 - visibleWidth(title) - visibleWidth(hint)));
	const lines = [frame("╭─ ") + theme.fg(TITLE[model.tone], title) + frame(` ${fill}`) + (hint ? theme.fg("dim", hint) : "") + frame("╮")];
	const inner = w - 4;
	for (const row of model.rows) {
		const text = truncateToWidth(row.text, inner, "…");
		const pad = " ".repeat(Math.max(0, inner - visibleWidth(text)));
		lines.push(`${frame("│")} ${theme.fg(ROW[row.tone ?? "info"], text)}${pad} ${frame("│")}`);
	}
	lines.push(frame(`╰${"─".repeat(w - 2)}╯`));
	return lines;
}
