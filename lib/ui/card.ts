// The "Background" and "Orca" cards shown above the editor, in the visual language
// of Gentle Shell cards (rounded frame, glyph title, tone by state). The model
// builder is pure and testable; the renderer only frames lines to a width.
//
// It is a plain widget (ctx.ui.setWidget), like gentle's Agents card: the
// Gentle fullscreen rail only paints its own fixed sections.

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { OrcaState } from "../orca/machine.ts";
import type { ActivitySeen } from "../orca/activity.ts";
import { DEFAULT_FLEET_CONFIG, isInProgress, summarize, type FleetState, type WorkerDetail, type WorkerRow } from "../orca/fleet.ts";
import type { TaskSnapshot } from "../tasks/manager.ts";
import { formatDuration, shortId } from "../text.ts";

export type Tone = "muted" | "info" | "success" | "warning" | "error";

export interface CardRow {
	text: string;
	tone?: Tone;
}

export interface CardModel {
	glyph: string;
	title: string;
	tone: Tone;
	rows: CardRow[];
	hint?: string;
}

export interface BgCardInput {
	now: number;
	tasks: TaskSnapshot[];
	/** Last output line per running task id (already sanitized). */
	lastLines?: Map<string, string>;
	collapsed?: boolean;
	/** Finished tasks stay visible this long. */
	finishedTtlMs?: number;
	maxRows?: number;
}

export interface OrcaCardInput {
	now: number;
	orca?: OrcaState;
	fleet?: FleetState;
	fleetIncomplete?: boolean;
	/** Run objective, shown instead of the opaque run id. */
	objective?: string;
	/** Agent, model and start time per dispatch id. */
	details?: Map<string, WorkerDetail>;
	/** Latest activity per dispatch id, from its terminal, and since when it is unchanged. */
	activity?: Map<string, ActivitySeen>;
	/** The model an agent uses when no `--model` was passed, if known. */
	defaultModel?: (agent: string) => string | undefined;
	collapsed?: boolean;
	maxRows?: number;
}

const TONES: Tone[] = ["muted", "info", "success", "warning", "error"];

function toneTracker() {
	let tone: Tone = "info";
	return {
		raise(t: Tone) {
			if (TONES.indexOf(t) > TONES.indexOf(tone)) tone = t;
		},
		get tone() {
			return tone;
		},
	};
}

function fit(rows: CardRow[], collapsed: boolean | undefined, max: number, more: string): CardRow[] {
	const visible = collapsed ? rows.filter((r) => r.tone === "warning" || r.tone === "error").slice(0, 2) : rows.slice(0, max);
	const hidden = rows.length - visible.length;
	if (hidden > 0) visible.push({ text: `… ${hidden} más (${more})`, tone: "muted" });
	return visible;
}

function taskOutcome(t: TaskSnapshot): { mark: string; text: string; tone: Tone } {
	switch (t.status) {
		case "exited":
			return t.exitCode === 0 ? { mark: "✔", text: "terminó bien", tone: "success" } : { mark: "✖", text: `falló (código ${t.exitCode ?? "?"})`, tone: "error" };
		case "matched":
			return { mark: "✔", text: "encontró el patrón", tone: "success" };
		case "timeout":
			return { mark: "✖", text: "tiempo agotado", tone: "error" };
		case "failed":
			return { mark: "✖", text: t.signal ? `terminada por ${t.signal}` : "no arrancó", tone: "error" };
		case "cancelled":
			return { mark: "■", text: "cancelada", tone: "muted" };
		default:
			return { mark: "▸", text: "en marcha", tone: "info" };
	}
}

/** Generic background tasks only; Orca state has its own card. */
export function buildBgCard(input: BgCardInput): CardModel | undefined {
	const ttl = input.finishedTtlMs ?? 60_000;
	const tasks = input.tasks.filter((t) => t.status === "running" || (t.endedAt !== undefined && input.now - t.endedAt < ttl));
	if (!tasks.length) return undefined;

	const rows: CardRow[] = [];
	const tone = toneTracker();
	for (const t of tasks) {
		const age = formatDuration((t.endedAt ?? input.now) - t.startedAt);
		const name = t.label !== t.id ? `${t.id} ${t.label}` : t.id;
		if (t.status === "running") {
			const last = input.lastLines?.get(t.id);
			// "$": a foreground command a worker is running (attached); "▸": background work.
			rows.push({ text: `${t.attached ? "$" : "▸"} ${name} · ${age}${last ? ` · ${last}` : ""}` });
		} else {
			const o = taskOutcome(t);
			rows.push({ text: `${o.mark} ${name} · ${o.text} · ${age}`, tone: o.tone });
			if (o.tone === "error") tone.raise("warning");
		}
	}

	const running = tasks.filter((t) => t.status === "running").length;
	return {
		glyph: "⏵",
		title: `Segundo plano · ${running ? `${running} en marcha` : "terminadas"}`,
		tone: tone.tone,
		rows: fit(rows, input.collapsed, input.maxRows ?? 8, "/bg"),
		hint: input.collapsed ? "plegada" : undefined,
	};
}

interface WorkerLook {
	mark: string;
	state: string;
	tone?: Tone;
}

/** What one open (or to-release) worker is doing, in plain words. */
export function workerLook(r: WorkerRow, activitySince: number, now: number, stallMs = 3 * 60_000, seen?: ActivitySeen, quietMs = DEFAULT_FLEET_CONFIG.quietMs): WorkerLook {
	if (r.nextAction === "release") {
		return r.outcome === "failed" ? { mark: "✖", state: "falló · falta cerrarlo", tone: "error" } : { mark: "✔", state: "terminó · falta cerrarlo", tone: "success" };
	}
	if (r.activity === "blocked") return { mark: "⚠", state: "esperando una respuesta en su terminal", tone: "warning" };
	if (r.livenessReason === "stale_status") return { mark: "⏸", state: "sin señal", tone: "warning" };
	if (r.activity === "working") {
		const quiet = seen && !seen.text.startsWith("⏵ ") ? now - seen.since : 0;
		return quiet >= quietMs ? { mark: "⏸", state: `sin cambios ${formatDuration(quiet)}`, tone: "warning" } : { mark: "▸", state: "trabajando" };
	}
	if (r.activity === "done" || r.activity === "idle") {
		return now - activitySince >= stallMs ? { mark: "⏸", state: `parado ${formatDuration(now - activitySince)} sin terminar`, tone: "warning" } : { mark: "·", state: "esperando" };
	}
	return { mark: "·", state: "arrancando" };
}

/** The coordinator's agents, plus the bridge when it needs attention. Hidden while no agent is orchestrated and the bridge is just listening. */
export function buildOrcaCard(input: OrcaCardInput): CardModel | undefined {
	const orca = input.orca && input.orca.phase !== "off" ? input.orca : undefined;
	if (!orca) return undefined;
	const fleet = input.fleet;
	const sum = fleet ? summarize(fleet, input.now) : undefined;

	const rows: CardRow[] = [];
	const tone = toneTracker();
	switch (orca.phase) {
		case "pending":
		case "acking":
			rows.push({ text: `◆ hay mensajes de los agentes sin procesar${orca.pendingSince !== null ? ` · ${formatDuration(input.now - orca.pendingSince)}` : ""}`, tone: "warning" });
			tone.raise("warning");
			break;
		case "backoff": {
			const left = orca.retryAt !== null ? formatDuration(Math.max(0, orca.retryAt - input.now)) : "?";
			const why = orca.reason.startsWith("another waiter") ? "otra sesión está leyendo los mensajes" : "sin conexión con Orca";
			rows.push({ text: `⚠ ${why} · reintento en ${left}`, tone: "warning" });
			tone.raise("warning");
			break;
		}
		case "fenced":
			rows.push({ text: "✕ esta terminal ya no coordina el Run", tone: "error" });
			tone.raise("error");
			break;
	}

	let open = 0;
	if (fleet) {
		for (const t of fleet.workers.values()) {
			const r = t.row;
			if (!isInProgress(r) && r.nextAction !== "release") continue;
			if (isInProgress(r)) open++;
			const task = fleet.tasks.get(r.taskId);
			const detail = input.details?.get(r.dispatchId);
			const seen = isInProgress(r) ? input.activity?.get(r.dispatchId) : undefined;
			const look = workerLook(r, t.activitySince, input.now, undefined, seen);
			if (look.tone === "warning" || look.tone === "error") tone.raise(look.tone === "error" ? "warning" : look.tone);
			const elapsed = detail?.startedAt != null ? formatDuration(Math.max(0, (t.settledAt ?? input.now) - detail.startedAt)) : "";
			const human = r.ownership === "user_owned" ? " · lo manejas tú" : "";
			const agent = detail?.agent || r.provider;
			// A reused terminal runs whatever its owner launched: do not guess.
			const model = detail?.model || (agent && !detail?.reusedTerminal ? input.defaultModel?.(agent) : undefined);
			const who = [agent, model ? `${model}${detail?.model ? "" : " (por defecto)"}${detail?.effort ? ` ${detail.effort}` : ""}` : ""].filter(Boolean).join(" · ");
			rows.push({ text: `${look.mark} ${task?.title || r.taskId} · ${look.state}${elapsed ? ` · ${elapsed}` : ""}${who ? ` · ${who}` : ""}${human}`, ...(look.tone ? { tone: look.tone } : {}) });
			if (seen) rows.push({ text: `  ↳ ${oneLine(seen.text)}`, tone: "muted" });
		}
	}
	// Nothing orchestrated and nothing wrong: a listening bridge alone is noise.
	const agents = open + (sum?.toRelease ?? 0);
	if (!agents && orca.phase === "waiting") return undefined;
	if (agents && sum?.readyTasks) rows.push({ text: `${sum.readyTasks} ${sum.readyTasks === 1 ? "tarea lista" : "tareas listas"} sin agente`, tone: "warning" });
	if (input.fleetIncomplete) rows.push({ text: "(lista parcial)", tone: "muted" });

	const name = input.objective?.trim() || (orca.runId ? shortId(orca.runId) : "orquestación");
	const count = open ? ` · ${open} ${open === 1 ? "agente" : "agentes"}` : "";
	return {
		glyph: "⇄",
		title: `Orca · ${name}${count}`,
		tone: tone.tone,
		rows: fit(rows, input.collapsed, input.maxRows ?? 12, "orca_workers"),
		hint: input.collapsed ? "plegada" : undefined,
	};
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export interface CardTheme {
	fg(color: string, text: string): string;
}

const FRAME: Record<Tone, string> = { muted: "border", info: "border", success: "success", warning: "warning", error: "error" };
const TITLE: Record<Tone, string> = { muted: "accent", info: "accent", success: "success", warning: "warning", error: "error" };
const ROW: Record<Tone, string> = { muted: "dim", info: "text", success: "success", warning: "warning", error: "error" };

export function renderCardLines(model: CardModel, theme: CardTheme, width: number): string[] {
	const w = Math.max(10, Math.floor(width));
	const frame = (t: string) => theme.fg(FRAME[model.tone], t);
	const head = `${model.glyph} ${model.title}`;
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
