// Model-facing text for fleet notices and the orca_workers table. Pure.

import { clip, formatDuration, sanitizeTerminal } from "../text.ts";
import { redact } from "../redact.ts";
import { formatModel, resolveWorkerModel } from "./model.ts";
import type { ActivitySeen } from "./activity.ts";
import { isInProgress, summarize, summaryLine, type FleetEvent, type FleetState, type WorkerDetail } from "./fleet.ts";

const clean = (text: string): string => redact(sanitizeTerminal(text));

const GUIDANCE: Record<string, string> = {
	quiet: "It still reports working, but its activity (same command or line) has not changed for a while. Read it (orca orchestration worker-read --dispatch <id>): a long build or test may be fine; if it looks stuck, send it a follow-up (orca orchestration send --to dispatch:<id> ...). A Pi worker with pi-bg moves a blocking command to the background when your message arrives, so it can read it.",
	scope: "The worker changed files outside the allowed edit surfaces. Inspect the exact paths and coordinate corrections; pi-bg never writes to the worker's repository.",
	stall: "The worker says it is working, but its screen has not changed for the configured interval. Read it and check its latest heartbeat/status before deciding whether to follow up.",
	loop: "Repeated waiting phrases were detected without visible progress. Read the worker screen and verify the awaited operation before steering it.",
	prompt: "The worker is waiting for an answer. The question and visible options are included below; answer or select an option in that worker's terminal when appropriate.",
	finished: "The worker finished or exited but its terminal is not closed. Use orca_release after confirming the settled outcome.",
	stalled: "It ended its turn without worker_done. Inspect it (orca orchestration worker-read --dispatch <id>) and decide: send it a follow-up (orca orchestration send --to dispatch:<id> ...), or stop/abandon only with positive proof it exited.",
	blocked: "Its terminal waits on an interactive prompt (for example a guarded git push). Read it with worker-read and decide whether you or the user should answer.",
	exited: "Its process exited without worker_done. Follow its nextAction (worker-read / recovery) before retrying.",
	attention: "Orca flags it as needing action. Check worker-show for the pending input/approval/failure.",
	release: "Release it if nothing more is needed (orca orchestration worker-release --dispatch <id>).",
	fleet_idle: "No worker is working while work is still open: continue the plan (follow up, relaunch, or report to the user).",
	ready_tasks: "Tasks are ready (dependencies done) but have no worker: launch them or report why not.",
};

const LABEL: Record<string, string> = {
	stalled: "STALLED",
	quiet: "NO CHANGE",
	blocked: "BLOCKED",
	exited: "EXITED",
	attention: "ATTENTION",
	settled: "settled",
	release: "to release",
	ready_tasks: "ready tasks",
	fleet_idle: "FLEET IDLE",
	resumed: "update",
	scope: "SCOPE",
	stall: "SCREEN STALL",
	loop: "LOOP",
	prompt: "WAITING FOR ANSWER",
	finished: "FINISHED · NOT CLOSED",
};

export function fleetEventLine(e: FleetEvent): string {
	const who = e.dispatchId ? `${clip(clean(e.title ?? e.dispatchId), 60)} (${e.dispatchId})` : "fleet";
	const since = e.sinceMs !== undefined ? ` for ${formatDuration(e.sinceMs)}` : "";
	const detail = e.detail ? `: ${clean(e.detail)}` : "";
	// A settled notice follows the worker_done delivery, which may already have been handled.
	const skip = e.kind === "settled" ? " (skip it if you already acted on this worker's worker_done delivery)" : "";
	const notes = e.notes?.length ? `\n    your note: ${e.notes.map((n) => clip(clean(n), 300)).join(" | ")}${skip}` : "";
	return `- ${LABEL[e.kind] ?? e.kind} ${who}${since}${detail}${notes}`;
}

/** Only these kinds wake the model; the rest ride along or go to the card. */
export const WAKE_KINDS = new Set(["stalled", "quiet", "blocked", "exited", "attention", "release", "fleet_idle", "ready_tasks", "scope", "stall", "loop", "prompt", "finished"]);

export function shouldWake(events: FleetEvent[]): boolean {
	return events.some((e) => WAKE_KINDS.has(e.kind) || (e.notes?.length ?? 0) > 0);
}

/** New watchdog findings, an exited worker and attention bypass the ordinary fleet notice wake budget. */
export function mustWake(events: FleetEvent[]): boolean {
	return events.some((event) => ["scope", "stall", "loop", "prompt", "finished", "exited", "attention"].includes(event.kind));
}

/** Detectors that describe the same worker condition, most specific first. */
const CONDITIONS: Array<{ group: string; kinds: FleetEvent["kind"][] }> = [
	{ group: "question", kinds: ["prompt", "attention", "blocked"] },
	{ group: "closure", kinds: ["finished", "release"] },
	{ group: "stuck", kinds: ["stall", "stalled", "quiet"] },
];

function conditionOf(e: FleetEvent): { group: string; rank: number } | undefined {
	// Attention is an open question only when it asks for input.
	if (e.kind === "attention" && !/input/.test(e.detail ?? "")) return undefined;
	for (const c of CONDITIONS) {
		const rank = c.kinds.indexOf(e.kind);
		if (rank >= 0) return { group: c.group, rank };
	}
	return undefined;
}

/**
 * One notice per worker condition. Within a batch the most specific detector
 * wins and inherits the others' notes; a condition reported for a worker in the
 * last `windowMs` is not reported again unless it carries a watch note. Fleet
 * idle is dropped when every open worker already has its own notice.
 * Records what it keeps in `memory` (`dispatchId|group` -> time).
 */
export function dedupeFleetEvents(events: FleetEvent[], memory: Map<string, number>, now: number, openIds: string[], windowMs = 10 * 60_000): FleetEvent[] {
	const kept: FleetEvent[] = [];
	const best = new Map<string, { event: FleetEvent; rank: number; notes: string[] }>();
	for (const e of events) {
		const c = e.dispatchId ? conditionOf(e) : undefined;
		if (!c) {
			kept.push(e);
			continue;
		}
		const slot = `${e.dispatchId}|${c.group}`;
		const cur = best.get(slot);
		const notes = [...(cur?.notes ?? []), ...(e.notes ?? [])];
		if (!cur || c.rank < cur.rank) best.set(slot, { event: e, rank: c.rank, notes });
		else cur.notes = notes;
	}
	for (const [slot, { event, notes }] of best) {
		const last = memory.get(slot);
		if (last !== undefined && now - last < windowMs && notes.length === 0) continue;
		memory.set(slot, now);
		kept.push(notes.length ? { ...event, notes: [...new Set(notes)] } : event);
	}
	const covered = new Set(kept.filter((e) => e.dispatchId).map((e) => e.dispatchId));
	return kept.filter((e) => e.kind !== "fleet_idle" || openIds.length === 0 || !openIds.every((id) => covered.has(id)));
}

export function formatFleetNotice(events: FleetEvent[], state: FleetState, runId: string, now: number): string {
	const lines = [`Orca fleet · run ${runId} · ${summaryLine(summarize(state, now))}`];
	for (const e of events.slice(0, 20)) lines.push(fleetEventLine(e));
	if (events.length > 20) lines.push(`- … ${events.length - 20} more (orca_workers shows all)`);
	const kinds = [...new Set(events.map((e) => e.kind))].filter((k) => GUIDANCE[k]);
	if (kinds.length) {
		lines.push("");
		for (const k of kinds) lines.push(`${LABEL[k]}: ${GUIDANCE[k]}`);
	}
	lines.push("pi-bg only observes: you decide what to do. orca_workers shows the whole fleet.");
	return clip(lines.join("\n"), 6_000);
}

export interface WorkersTableOptions {
	all?: boolean;
	/** Live activity per dispatch (what it is doing now, since when unchanged). */
	activity?: Map<string, ActivitySeen>;
	/** Agent, model and dispatch time per dispatch. */
	details?: Map<string, WorkerDetail>;
}

export function formatWorkersTable(state: FleetState, runId: string, now: number, options: WorkersTableOptions = {}): string {
	const rows = [...state.workers.values()].filter((t) => options.all || isInProgress(t.row) || t.row.nextAction !== "none");
	const lines = [`Orca fleet · run ${runId} · ${summaryLine(summarize(state, now))}`];
	if (!rows.length) lines.push(options.all ? "No workers in this Run." : "No open workers (pass all=true for settled history).");
	for (const t of rows) {
		const r = t.row;
		const title = state.tasks.get(r.taskId)?.title || r.taskId;
		const activity = r.liveness === "live" ? `${r.activity} ${formatDuration(now - t.activitySince)}` : `${r.liveness}${r.livenessReason ? `/${r.livenessReason}` : ""}`;
		const attention = r.attention.filter((c) => c !== "root_completion");
		const detail = options.details?.get(r.dispatchId);
		const model = resolveWorkerModel({
			launch: detail?.model ? { provider: detail.provider, model: detail.model, thinking: detail.effort || undefined } : undefined,
			status: detail?.statusModel,
			reusedTerminal: detail?.reusedTerminal,
		});
		const modelText = formatModel(model);
		const who = detail?.agent ? ` · ${detail.agent}${modelText ? ` ${modelText}` : ""}` : "";
		const elapsed = detail?.startedAt != null ? ` · started ${formatDuration(Math.max(0, now - detail.startedAt))} ago` : "";
		lines.push(
			`- ${clip(clean(title), 50)} · ${r.dispatchId} · ${r.outcome} · ${activity}${who}${elapsed}${r.ownership === "user_owned" ? " · human-driven" : ""}${attention.length ? ` · attention ${attention.join(",")}` : ""}${r.nextAction !== "none" ? ` · next: ${r.nextAction}` : ""}`,
		);
		const seen = isInProgress(r) ? options.activity?.get(r.dispatchId) : undefined;
		if (seen) lines.push(`    now: ${clip(clean(seen.text), 160)} (unchanged ${formatDuration(Math.max(0, now - seen.since))})`);
	}
	const ready = [...state.tasks.values()].filter((task) => (task.status === "pending" || task.status === "ready") && ![...state.workers.values()].some((w) => w.row.taskId === task.id));
	if (ready.length) lines.push(`Tasks without a worker: ${ready.map((task) => `${clip(clean(task.title || task.id), 40)}${task.deps.length ? ` (deps ${task.deps.length})` : ""}`).slice(0, 10).join(", ")}`);
	return clip(lines.join("\n"), 8_000);
}
