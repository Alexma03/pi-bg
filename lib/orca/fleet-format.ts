// Model-facing text for fleet notices and the orca_workers table. Pure.

import { clip, formatDuration, sanitizeTerminal } from "../text.ts";
import { redact } from "../redact.ts";
import type { ActivitySeen } from "./activity.ts";
import { isInProgress, summarize, summaryLine, type FleetEvent, type FleetState, type WorkerDetail } from "./fleet.ts";

const clean = (text: string): string => redact(sanitizeTerminal(text));

const GUIDANCE: Record<string, string> = {
	quiet: "It still reports working, but its activity (same command or line) has not changed for a while. Read it (orca orchestration worker-read --dispatch <id>): a long build or test may be fine; if it looks stuck, send it a follow-up (orca orchestration send --to dispatch:<id> ...). A Pi worker with pi-bg moves a blocking command to the background when your message arrives, so it can read it.",
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
};

export function fleetEventLine(e: FleetEvent): string {
	const who = e.dispatchId ? `${clip(clean(e.title ?? e.dispatchId), 60)} (${e.dispatchId})` : "fleet";
	const since = e.sinceMs !== undefined ? ` for ${formatDuration(e.sinceMs)}` : "";
	const detail = e.detail ? `: ${clean(e.detail)}` : "";
	const notes = e.notes?.length ? `\n    your note: ${e.notes.map((n) => clip(clean(n), 300)).join(" | ")}` : "";
	return `- ${LABEL[e.kind] ?? e.kind} ${who}${since}${detail}${notes}`;
}

/** Only these kinds wake the model; the rest ride along or go to the card. */
export const WAKE_KINDS = new Set(["stalled", "quiet", "blocked", "exited", "attention", "release", "fleet_idle", "ready_tasks"]);

export function shouldWake(events: FleetEvent[]): boolean {
	return events.some((e) => WAKE_KINDS.has(e.kind) || (e.notes?.length ?? 0) > 0);
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
		const who = detail?.agent ? ` · ${detail.agent}${detail.model ? ` ${detail.model}` : ""}` : "";
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
