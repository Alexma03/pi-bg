// Footer segment texts, one per concern (background tasks, Orca). Pure.

import type { OrcaState } from "./orca/machine.ts";
import { formatDuration } from "./text.ts";

export function orcaStatus(state: OrcaState, now: number): string | undefined {
	switch (state.phase) {
		case "off":
			return undefined;
		case "waiting":
			return "orca ◉ escuchando";
		case "pending":
		case "acking": {
			const age = state.pendingSince !== null ? ` ${formatDuration(now - state.pendingSince)}` : "";
			return `orca ◆ sin procesar${age}`;
		}
		case "backoff": {
			const left = state.retryAt !== null ? formatDuration(Math.max(0, state.retryAt - now)) : "?";
			return state.reason.startsWith("another waiter") ? `orca ⚠ otra sesión leyendo · reintento ${left}` : `orca ⚠ reintento ${left}`;
		}
		case "fenced":
			return "orca ✕ ya no coordina";
	}
}

export function bgStatus(runningTasks: number): string | undefined {
	return runningTasks > 0 ? `⏵ ${runningTasks} ${runningTasks === 1 ? "tarea" : "tareas"}` : undefined;
}
