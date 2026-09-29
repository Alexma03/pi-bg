// Safe, explicit release decisions for settled Orca workers. The native
// worker-release command remains authoritative; terminal close is only a
// narrow fallback after a fresh `exited` verdict for the exact owned handle.

import { SETTLED_OUTCOMES, type WorkerRow } from "./fleet.ts";

export type ReleaseStatus = "released" | "already_released" | "retained" | "release_pending" | "release_unknown" | "failed";

export interface ReleaseCapture { doc: unknown; exitCode: number | null }
export interface ReleaseOutcome { dispatchId: string; status: ReleaseStatus | "closed"; detail: string; resolved: boolean }
export interface ReleaseOps {
	run: (args: string[]) => Promise<ReleaseCapture>;
	refresh: (dispatchId: string) => Promise<WorkerRow | undefined>;
	resolved: (dispatchId: string) => void;
}

const RECLAIMABLE_TERMINAL_STATES = new Set(["reclaimable", "release_pending", "release_unknown"]);

function reclaimable(row: WorkerRow): boolean {
	if (!SETTLED_OUTCOMES.has(row.outcome)) return false;
	return row.nextAction === "release" || RECLAIMABLE_TERMINAL_STATES.has(row.terminalState) || (row.terminalState === "retained" && row.liveness === "exited");
}

/** Select only settled resources that Orca or a positive exit verdict says can be reclaimed. */
export function releaseSelection(rows: WorkerRow[], input: { dispatchId?: string; all?: boolean }): WorkerRow[] {
	if (Boolean(input.dispatchId) === (input.all === true)) throw new Error("choose dispatchId or all=true");
	if (input.dispatchId) {
		const found = rows.find((row) => row.dispatchId === input.dispatchId);
		if (!found || !reclaimable(found)) throw new Error(`Dispatch ${input.dispatchId} is not reclaimable (it must be settled first).`);
		return [found];
	}
	return rows.filter(reclaimable);
}

/** Parse the supported native worker-release states without treating retained as success. */
export function releaseStatus(doc: unknown, exitCode: number | null): ReleaseStatus {
	const root = doc && typeof doc === "object" ? (doc as Record<string, unknown>) : {};
	const result = root.result && typeof root.result === "object" ? (root.result as Record<string, unknown>) : {};
	const error = root.error && typeof root.error === "object" ? (root.error as Record<string, unknown>) : {};
	const state = [result.state, result.status, result.terminalState, error.code].find((v): v is string => typeof v === "string") ?? "";
	if (state === "released" || state === "already_released") return state;
	if (state === "retained" || state === "release_pending" || state === "release_unknown") return state;
	if (root.ok === true && exitCode === 0) return "released";
	return "failed";
}

/** Fallback is allowed only for exact, settled, non-human-owned, positively exited terminals. */
export function releaseFallbackAllowed(row: WorkerRow, status: ReleaseStatus): boolean {
	return (status === "release_unknown" || status === "retained") && SETTLED_OUTCOMES.has(row.outcome) && row.liveness === "exited" && Boolean(row.terminalHandle) && ["owned", "external"].includes(row.ownership);
}

function succeeded(capture: ReleaseCapture): boolean {
	const doc = capture.doc && typeof capture.doc === "object" ? (capture.doc as Record<string, unknown>) : {};
	return doc.ok === true && capture.exitCode === 0;
}

/** Run Orca's native release, with one exact-terminal close only after fresh exit proof. */
export async function releaseOne(row: WorkerRow, ops: ReleaseOps): Promise<ReleaseOutcome> {
	const capture = await ops.run(["orchestration", "worker-release", "--dispatch", row.dispatchId, "--json"]);
	const status = releaseStatus(capture.doc, capture.exitCode);
	if (status === "released" || status === "already_released") {
		ops.resolved(row.dispatchId);
		return { dispatchId: row.dispatchId, status, detail: `native worker-release: ${status}`, resolved: true };
	}
	if (status !== "release_unknown" && status !== "retained") return { dispatchId: row.dispatchId, status, detail: `native worker-release: ${status}`, resolved: false };

	const fresh = await ops.refresh(row.dispatchId);
	if (!fresh || fresh.terminalHandle !== row.terminalHandle || !releaseFallbackAllowed(fresh, status)) {
		return { dispatchId: row.dispatchId, status, detail: `native worker-release: ${status}; no fresh positive exit proof for the same owned terminal, so it was left untouched`, resolved: false };
	}
	const closed = await ops.run(["terminal", "close", "--terminal", fresh.terminalHandle, "--json"]);
	if (!succeeded(closed)) return { dispatchId: row.dispatchId, status, detail: `native worker-release: ${status}; terminal close was not confirmed`, resolved: false };
	ops.resolved(row.dispatchId);
	return { dispatchId: row.dispatchId, status: "closed", detail: `native worker-release: ${status}; closed the exact terminal after fresh exited evidence`, resolved: true };
}
