// Fleet watch driver: polls `worker-list` and `task-list` for the bound Run
// (read-only, never touches the mailbox), feeds lib/orca/fleet.ts and hands
// the resulting events to the extension. The model decides what to do.

import { extractJson, type CliCapture } from "./cli.ts";
import { runOrcaCli } from "./exec.ts";
import { addWatch, DEFAULT_FLEET_CONFIG, initialFleet, seedSeen, parseTasks, parseWorkerPage, updateFleet, type FleetConfig, type FleetEvent, type FleetState, type TaskRow, type Watch, type WorkerRow } from "./fleet.ts";

export interface FleetDeps {
	orcaBin: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	now: () => number;
	onEvents: (events: FleetEvent[], state: FleetState, runId: string) => void;
	onChange: () => void;
	pollMs?: number;
	config?: FleetConfig;
	/** Maximum worker-list pages per poll (100 rows each). */
	maxPages?: number;
}

type Doc = { ok?: unknown; result?: unknown; error?: { code?: unknown } };

function resultOf(capture: CliCapture): Record<string, unknown> | undefined {
	const doc = extractJson(capture.stdout) as Doc | undefined;
	if (!doc || doc.ok !== true || !doc.result || typeof doc.result !== "object") return undefined;
	return doc.result as Record<string, unknown>;
}

export class FleetWatch {
	state: FleetState = initialFleet();
	runId: string | null = null;
	/** The last poll could not read the whole fleet. */
	incomplete = false;
	lastPollAt: number | null = null;
	lastError: string | null = null;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private polling = false;
	private disposed = false;
	private readonly deps: FleetDeps;

	constructor(deps: FleetDeps) {
		this.deps = deps;
	}

	/** Start (or retarget) watching a Run. A new Run starts a fresh baseline. */
	watch(runId: string): void {
		if (this.disposed) return;
		if (this.runId !== runId) {
			// Switching Runs: watches name dispatches of the previous Run and do not
			// carry over. The first Run of a session keeps watches restored at start.
			this.state = this.runId === null ? { ...initialFleet(), watches: this.state.watches } : initialFleet();
			this.runId = runId;
			if (this.pendingSeed?.runId === runId) {
				this.state = seedSeen(this.state, this.pendingSeed.seen);
				this.pendingSeed = undefined;
			}
		}
		this.schedule(0);
	}

	stop(): void {
		this.runId = null;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	dispose(): void {
		this.disposed = true;
		this.stop();
	}

	/** Poll soon, e.g. right after a bash `worker-start`. */
	pokeSoon(delayMs = 2_000): void {
		if (this.runId) this.schedule(delayMs);
	}

	/** Keys notified before a reload for `runId`; applied when that Run is watched. */
	private pendingSeed: { runId: string; seen: Array<{ dispatchId?: string; key: string }> } | undefined;

	seed(runId: string, seen: Array<{ dispatchId?: string; key: string }>): void {
		if (this.runId === runId) this.state = seedSeen(this.state, seen);
		else this.pendingSeed = { runId, seen };
	}

	addWatch(watch: Watch): void {
		this.state = addWatch(this.state, watch);
		this.pokeSoon(0);
	}

	private schedule(delayMs: number): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.poll(), delayMs);
		this.timer.unref?.();
	}

	async poll(): Promise<void> {
		const runId = this.runId;
		if (!runId || this.polling || this.disposed) return;
		this.polling = true;
		try {
			const rows = await this.readWorkers(runId);
			const tasks = await this.readTasks(runId);
			if (this.runId !== runId || this.disposed) return;
			if (rows) {
				const { state, events } = updateFleet(this.state, rows, tasks, this.deps.now(), this.deps.config ?? DEFAULT_FLEET_CONFIG);
				this.state = state;
				this.lastPollAt = this.deps.now();
				// An incomplete inventory must not claim the fleet is idle.
				const usable = this.incomplete ? events.filter((e) => e.kind !== "fleet_idle" && e.kind !== "ready_tasks") : events;
				if (usable.length) this.deps.onEvents(usable, this.state, runId);
			}
		} finally {
			this.polling = false;
			this.deps.onChange();
			if (this.runId === runId && !this.disposed) this.schedule(this.deps.pollMs ?? 30_000);
		}
	}

	private async readWorkers(runId: string): Promise<WorkerRow[] | undefined> {
		const rows: WorkerRow[] = [];
		let cursor: string | null = null;
		const maxPages = this.deps.maxPages ?? 5;
		for (let page = 0; page < maxPages; page++) {
			const args = ["orchestration", "worker-list", "--run", runId, "--limit", "100", "--json"];
			if (cursor) args.splice(args.length - 1, 0, "--cursor", cursor);
			const result = resultOf(await runOrcaCli(this.deps.orcaBin, args, { cwd: this.deps.cwd, env: this.deps.env }));
			if (!result) {
				this.lastError = "worker-list failed";
				return undefined;
			}
			const parsed = parseWorkerPage(result);
			rows.push(...parsed.rows);
			if (!parsed.hasMore || !parsed.nextCursor) {
				this.incomplete = false;
				this.lastError = null;
				return rows;
			}
			cursor = parsed.nextCursor;
		}
		this.incomplete = true;
		this.lastError = `fleet larger than ${maxPages * 100} workers; showing the newest`;
		return rows;
	}

	private async readTasks(runId: string): Promise<TaskRow[] | undefined> {
		const result = resultOf(await runOrcaCli(this.deps.orcaBin, ["orchestration", "task-list", "--run", runId, "--json"], { cwd: this.deps.cwd, env: this.deps.env }));
		return result ? parseTasks(result) : undefined;
	}
}
