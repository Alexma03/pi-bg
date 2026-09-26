// Footer segment text. Pure.

import type { OrcaState } from "./orca/machine.ts";
import { formatDuration, shortId } from "./text.ts";

export function orcaStatus(state: OrcaState, now: number): string | undefined {
	const run = state.runId ? shortId(state.runId) : "";
	switch (state.phase) {
		case "off":
			return undefined;
		case "waiting":
			return `orca ◉ ${run}`;
		case "pending":
		case "acking": {
			const age = state.pendingSince !== null ? ` ${formatDuration(now - state.pendingSince)}` : "";
			return `orca ◆ ack pending${age} ${run}`;
		}
		case "backoff": {
			const left = state.retryAt !== null ? formatDuration(Math.max(0, state.retryAt - now)) : "?";
			return state.reason.startsWith("another waiter") ? `orca ⚠ another waiter · retry ${left}` : `orca ⚠ retry ${left}`;
		}
		case "fenced":
			return `orca ✕ not consumer ${run}`;
	}
}

export function footerText(runningTasks: number, orca: OrcaState | undefined, now: number): string | undefined {
	const parts: string[] = [];
	if (runningTasks > 0) parts.push(`⏵ ${runningTasks} bg`);
	const o = orca ? orcaStatus(orca, now) : undefined;
	if (o) parts.push(o);
	return parts.length ? parts.join(" · ") : undefined;
}
