// Compact live-state block appended to the system prompt each turn, only
// when there is something to say. It keeps pending acks and fleet problems
// in view after compaction. Pure; the text changes only when the state
// changes (ages are bucketed) so the prompt-cache prefix stays stable.

import type { OrcaState } from "./orca/machine.ts";
import { isInProgress, summarize, summaryLine, type FleetState } from "./orca/fleet.ts";
import type { TaskSnapshot } from "./tasks/manager.ts";

/** Coarse age buckets keep the block stable between turns. */
export function ageBucket(ms: number): string {
	const min = ms / 60_000;
	if (min < 1) return "<1m";
	if (min < 5) return "1-5m";
	if (min < 15) return "5-15m";
	if (min < 60) return "15-60m";
	return ">1h";
}

export function stateBlock(input: { now: number; tasks: TaskSnapshot[]; orca?: OrcaState; fleet?: FleetState; fleetIncomplete?: boolean }): string | undefined {
	const lines: string[] = [];
	const running = input.tasks.filter((t) => t.status === "running");
	if (running.length) {
		lines.push(`Background tasks running (bg_run): ${running.map((t) => `${t.id}${t.label !== t.id ? ` "${t.label.slice(0, 40)}"` : ""} ${ageBucket(input.now - t.startedAt)}`).join(", ")}. Their completion arrives as a pi-bg message; do not poll.`);
	}
	const orca = input.orca;
	if (orca && orca.phase !== "off") {
		if (orca.phase === "pending" || orca.phase === "acking") {
			lines.push(`Orca delivery ${orca.pending?.id} is pending: process all its messages, then orca_ack. The Run mailbox is paused until then (orca_workers {inbox: true} shows it).`);
		} else if (orca.phase === "backoff" || orca.phase === "fenced") {
			lines.push(`Orca bridge ${orca.phase}: ${orca.reason}.`);
		} else {
			lines.push(`Orca bridge listening on ${orca.runId}; deliveries arrive by themselves. Never run a consuming orca orchestration check or orca-wait.`);
		}
		const fleet = input.fleet;
		if (fleet) {
			const sum = summarize(fleet, input.now);
			if (sum.open || sum.toRelease || sum.readyTasks) {
				const problems = [...fleet.workers.values()]
					.filter((t) => isInProgress(t.row) && t.row.activity !== "working")
					.slice(0, 5)
					.map((t) => `${fleet.tasks.get(t.row.taskId)?.title || t.row.taskId || t.row.dispatchId} ${t.row.activity} ${ageBucket(input.now - t.activitySince)}`);
				lines.push(`Orca fleet: ${summaryLine(sum)}${input.fleetIncomplete ? " (partial inventory)" : ""}${problems.length ? `; not working: ${problems.join(", ")}` : ""}. Work is not finished while workers are open; orca_workers shows details.`);
			}
		}
	}
	if (!lines.length) return undefined;
	return ["## pi-bg live state", ...lines.map((l) => `- ${l}`)].join("\n");
}
