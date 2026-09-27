// Fleet watch driver: polls `worker-list` and `task-list` for the bound Run
// (read-only, never touches the mailbox), feeds lib/orca/fleet.ts and hands
// the resulting events to the extension. The model decides what to do.

import { extractJson, type CliCapture } from "./cli.ts";
import { runOrcaCli } from "./exec.ts";
import { lastActivity } from "./activity.ts";
import { redact } from "../redact.ts";
import { clip, sanitizeTerminal } from "../text.ts";
import { addWatch, isInProgress, DEFAULT_FLEET_CONFIG, initialFleet, seedSeen, parseTasks, parseWorkerPage, parseWorkerShow, updateFleet, type WorkerDetail, type FleetConfig, type FleetEvent, type FleetState, type TaskRow, type Watch, type WorkerRow } from "./fleet.ts";

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
	/** How often the live activity line of open workers is refreshed; 0 disables it. */
	activityMs?: number;
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
	/** Run objective, for display ("" until read). */
	objective = "";
	/** Agent, model and start time per dispatch; immutable, so read once. */
	readonly details = new Map<string, WorkerDetail>();
	/** Latest activity line per open dispatch, from its terminal tail (sanitized, redacted). */
	readonly activity = new Map<string, string>();
	private activityTimer: ReturnType<typeof setInterval> | undefined;
	private readingActivity = false;
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
			this.objective = "";
			this.details.clear();
			this.activity.clear();
			if (this.pendingSeed?.runId === runId) {
				this.state = seedSeen(this.state, this.pendingSeed.seen);
				this.pendingSeed = undefined;
			}
		}
		this.schedule(0);
		const every = this.deps.activityMs ?? 10_000;
		if (every > 0 && !this.activityTimer) {
			this.activityTimer = setInterval(() => void this.readActivity(), every);
			this.activityTimer.unref?.();
		}
	}

	stop(): void {
		this.runId = null;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.activityTimer) clearInterval(this.activityTimer);
		this.activityTimer = undefined;
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
				await this.readDisplay(runId, rows);
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

	/** Refresh the activity line of open workers (display only; bounded). */
	async readActivity(): Promise<void> {
		const runId = this.runId;
		if (!runId || this.disposed || this.readingActivity) return;
		this.readingActivity = true;
		try {
			const open = [...this.state.workers.values()].filter((t) => isInProgress(t.row)).slice(0, 6);
			for (const id of [...this.activity.keys()]) if (!open.some((t) => t.row.dispatchId === id)) this.activity.delete(id);
			let changed = false;
			for (const t of open) {
				if (this.runId !== runId || this.disposed) return;
				const result = resultOf(await runOrcaCli(this.deps.orcaBin, ["orchestration", "worker-read", "--dispatch", t.row.dispatchId, "--limit", "40", "--json"], { cwd: this.deps.cwd, env: this.deps.env }));
				const terminal = result && typeof result.terminal === "object" && result.terminal ? (result.terminal as Record<string, unknown>) : undefined;
				const tail = Array.isArray(terminal?.tail) ? terminal.tail.filter((l): l is string => typeof l === "string").map(sanitizeTerminal) : undefined;
				if (!tail) continue;
				const line = lastActivity(tail);
				const text = line ? clip(redact(line), 200) : "";
				if (text && this.activity.get(t.row.dispatchId) !== text) {
					this.activity.set(t.row.dispatchId, text);
					changed = true;
				}
			}
			if (changed) this.deps.onChange();
		} finally {
			this.readingActivity = false;
		}
	}

	/** Display-only reads; failures just leave the fields empty. */
	private async readDisplay(runId: string, rows: WorkerRow[]): Promise<void> {
		const opts = { cwd: this.deps.cwd, env: this.deps.env };
		if (!this.objective) {
			const result = resultOf(await runOrcaCli(this.deps.orcaBin, ["orchestration", "run-show", "--id", runId, "--json"], opts));
			const run = result && typeof result.run === "object" && result.run ? (result.run as Record<string, unknown>) : undefined;
			if (typeof run?.objective === "string") this.objective = run.objective;
		}
		// Bounded: a few new dispatches per poll, open ones first.
		const missing = rows.filter((r) => !this.details.has(r.dispatchId) && (isInProgress(r) || r.nextAction === "release")).slice(0, 4);
		for (const r of missing) {
			if (this.runId !== runId || this.disposed) return;
			const result = resultOf(await runOrcaCli(this.deps.orcaBin, ["orchestration", "worker-show", "--dispatch", r.dispatchId, "--json"], opts));
			if (result) this.details.set(r.dispatchId, parseWorkerShow(result));
		}
	}

	private async readTasks(runId: string): Promise<TaskRow[] | undefined> {
		const result = resultOf(await runOrcaCli(this.deps.orcaBin, ["orchestration", "task-list", "--run", runId, "--json"], { cwd: this.deps.cwd, env: this.deps.env }));
		return result ? parseTasks(result) : undefined;
	}
}
