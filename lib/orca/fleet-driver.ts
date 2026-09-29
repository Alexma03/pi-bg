// Fleet watch driver: polls `worker-list` and `task-list` for the bound Run
// (read-only, never touches the mailbox), feeds lib/orca/fleet.ts and hands
// the resulting events to the extension. The model decides what to do.

import { extractJson, type CliCapture } from "./cli.ts";
import { runOrcaCli } from "./exec.ts";
import { lastActivity, nextActivity, type ActivitySeen } from "./activity.ts";
import { parsePiStatusModel } from "./model.ts";
import { DEFAULT_WATCHDOG_CONFIG, evaluateWatchdog, gitChangedFiles, initialWatchdogState, normalizeWatchdogConfig, parseAllowedEditSurfaces, type WatchdogConfig, type WatchdogState } from "./watchdog.ts";
import { dirname, isAbsolute } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { redact } from "../redact.ts";
import { clip, sanitizeTerminal } from "../text.ts";
import { addWatch, isInProgress, quietEvents, DEFAULT_FLEET_CONFIG, initialFleet, seedSeen, parseTasks, parseWorkerPage, parseWorkerShow, updateFleet, type WorkerDetail, type FleetConfig, type FleetEvent, type FleetState, type TaskRow, type Watch, type WorkerRow } from "./fleet.ts";

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
	/** How often terminal snapshots are refreshed; defaults to the watchdog cadence. 0 disables it. */
	activityMs?: number;
	/** pi-bg-owned persistence path; never a worker repository. */
	watchdogPath?: string;
	watchdogConfig?: Partial<WatchdogConfig>;
}

type Doc = { ok?: unknown; result?: unknown; error?: { code?: unknown } };

function resultOf(capture: CliCapture): Record<string, unknown> | undefined {
	const doc = extractJson(capture.stdout) as Doc | undefined;
	if (!doc || doc.ok !== true || !doc.result || typeof doc.result !== "object") return undefined;
	return doc.result as Record<string, unknown>;
}

function parseWatchdogState(value: unknown): WatchdogState {
	const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const lastNotified = raw.lastNotified && typeof raw.lastNotified === "object" ? Object.fromEntries(Object.entries(raw.lastNotified).filter(([, at]) => typeof at === "number")) as Record<string, number> : {};
	const screens = raw.screens && typeof raw.screens === "object" ? Object.fromEntries(Object.entries(raw.screens).filter(([, row]) => row && typeof row === "object" && typeof (row as Record<string, unknown>).fingerprint === "string" && typeof (row as Record<string, unknown>).since === "number")) as WatchdogState["screens"] : {};
	const waits = raw.waits && typeof raw.waits === "object" ? Object.fromEntries(Object.entries(raw.waits).filter(([, row]) => row && typeof row === "object" && typeof (row as Record<string, unknown>).count === "number")) as WatchdogState["waits"] : {};
	return { active: Array.isArray(raw.active) ? raw.active.filter((key): key is string => typeof key === "string") : [], lastNotified, screens, waits };
}

export class FleetWatch {
	state: FleetState = initialFleet();
	runId: string | null = null;
	/** The last poll could not read the whole fleet. */
	incomplete = false;
	lastPollAt: number | null = null;
	lastError: string | null = null;
	/** Optional coordinator-owned short label; the Run's original objective is intentionally not reused. */
	label = "";
	/** Agent, model, worktree and start time per dispatch, enriched by terminal observations. */
	readonly details = new Map<string, WorkerDetail>();
	/** Latest activity per dispatch, from its terminal tail (sanitized, redacted), and since when it is unchanged. */
	readonly activity = new Map<string, ActivitySeen>();
	readonly tails = new Map<string, string[]>();
	private activityTimer: ReturnType<typeof setInterval> | undefined;
	private watchdogConfig: WatchdogConfig;
	private watchdogState: WatchdogState = initialWatchdogState();
	private watchdogLoaded = false;
	private watchdogLastScan = Number.NEGATIVE_INFINITY;
	private resolvedRelease = new Set<string>();
	private readingActivity = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private polling = false;
	private pollWaiters: Array<() => void> = [];
	private disposed = false;
	private readonly deps: FleetDeps;

	constructor(deps: FleetDeps) {
		this.deps = deps;
		this.watchdogConfig = normalizeWatchdogConfig(deps.watchdogConfig ?? {}, DEFAULT_WATCHDOG_CONFIG);
	}

	get watchdog(): WatchdogConfig {
		return { ...this.watchdogConfig, scopeGlobs: [...this.watchdogConfig.scopeGlobs] };
	}

	async configureWatchdog(patch: Partial<WatchdogConfig>): Promise<WatchdogConfig> {
		await this.loadWatchdog();
		this.watchdogConfig = normalizeWatchdogConfig({ ...this.watchdogConfig, ...patch }, this.watchdogConfig);
		this.watchdogLastScan = Number.NEGATIVE_INFINITY;
		this.resetActivityTimer();
		await this.persistWatchdog();
		return this.watchdog;
	}

	async setLabel(label: string): Promise<string> {
		await this.loadWatchdog();
		this.label = label.trim().slice(0, 80);
		await this.persistWatchdog();
		return this.label;
	}

	/** Mark an explicitly released/closed terminal so stale snapshots do not count as closure debt. */
	markReleased(dispatchId: string): void {
		this.resolvedRelease.add(dispatchId);
		const tracked = this.state.workers.get(dispatchId);
		if (tracked) tracked.row = { ...tracked.row, terminalState: "released", nextAction: "none" };
	}

	seedReleased(dispatchIds: string[]): void {
		for (const id of dispatchIds) if (typeof id === "string" && id) this.resolvedRelease.add(id);
	}

	worker(dispatchId: string): WorkerRow | undefined {
		return this.state.workers.get(dispatchId)?.row;
	}

	private resetActivityTimer(): void {
		if (this.activityTimer) clearInterval(this.activityTimer);
		this.activityTimer = undefined;
		const every = this.deps.activityMs ?? this.watchdogConfig.cadenceMs;
		if (this.runId && every > 0) {
			this.activityTimer = setInterval(() => void this.readActivity(), every);
			this.activityTimer.unref?.();
		}
	}

	private async loadWatchdog(): Promise<void> {
		if (this.watchdogLoaded) return;
		this.watchdogLoaded = true;
		const file = this.deps.watchdogPath;
		if (!file) return;
		try {
			const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
			this.watchdogConfig = normalizeWatchdogConfig(raw.config, this.watchdogConfig);
			if (Array.isArray(raw.resolvedRelease)) this.seedReleased(raw.resolvedRelease.filter((id): id is string => typeof id === "string"));
			if (raw.runId === this.runId) {
				this.watchdogState = parseWatchdogState(raw.state);
				this.watchdogLastScan = typeof raw.lastScanAt === "number" ? raw.lastScanAt : Number.NEGATIVE_INFINITY;
				this.label = typeof raw.label === "string" ? raw.label.slice(0, 80) : "";
			}
		} catch {
			/* first run or old/corrupt state: fail closed to fresh detector state */
		}
	}

	private async persistWatchdog(): Promise<void> {
		const file = this.deps.watchdogPath;
		if (!file) return;
		try {
			await mkdir(dirname(file), { recursive: true, mode: 0o700 });
			const tmp = `${file}.tmp`;
			await writeFile(tmp, JSON.stringify({ version: 1, runId: this.runId, label: this.label, config: this.watchdogConfig, state: this.watchdogState, lastScanAt: this.watchdogLastScan, resolvedRelease: [...this.resolvedRelease] }), { mode: 0o600 });
			await rename(tmp, file);
		} catch {
			/* state persistence is best-effort; detector still runs in memory */
		}
	}

	/** Start (or retarget) watching a Run. A new Run starts a fresh baseline. */
	watch(runId: string): void {
		if (this.disposed || this.runId === runId) return;
		// Switching Runs: watches name dispatches of the previous Run and do not
		// carry over. The first Run of a session keeps watches restored at start.
		this.state = this.runId === null ? { ...initialFleet(), watches: this.state.watches } : initialFleet();
		this.runId = runId;
		this.label = "";
		this.details.clear();
		this.activity.clear();
		this.tails.clear();
		this.watchdogState = initialWatchdogState();
		this.watchdogLoaded = false;
		this.watchdogLastScan = Number.NEGATIVE_INFINITY;
		if (this.pendingSeed?.runId === runId) {
			this.state = seedSeen(this.state, this.pendingSeed.seen);
			this.pendingSeed = undefined;
		}
		this.schedule(0);
		this.resetActivityTimer();
		void this.loadWatchdog().then(() => {
			this.resetActivityTimer();
			this.deps.onChange();
		});
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
		if (!runId || this.disposed) return;
		if (this.polling) {
			await new Promise<void>((resolve) => this.pollWaiters.push(resolve));
			return;
		}
		this.polling = true;
		try {
			const rows = await this.readWorkers(runId);
			const tasks = await this.readTasks(runId);
			if (this.runId !== runId || this.disposed) return;
			if (rows) {
				const normalizedRows = rows.map((row) => this.resolvedRelease.has(row.dispatchId) ? { ...row, terminalState: "released", nextAction: "none" } : row);
				const { state, events } = updateFleet(this.state, normalizedRows, tasks, this.deps.now(), this.deps.config ?? DEFAULT_FLEET_CONFIG);
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
			for (const resolve of this.pollWaiters.splice(0)) resolve();
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

	/** Refresh worker screens and run the model-free watchdog at its configured cadence. */
	async readActivity(): Promise<void> {
		const runId = this.runId;
		if (!runId || this.disposed || this.readingActivity) return;
		this.readingActivity = true;
		try {
			await this.loadWatchdog();
			const watched = [...this.state.workers.values()].filter((t) => isInProgress(t.row) || t.row.liveness === "exited" || t.row.nextAction === "release");
			for (const id of [...this.activity.keys()]) if (!watched.some((t) => t.row.dispatchId === id && isInProgress(t.row))) this.activity.delete(id);
			let changed = false;
			for (let start = 0; start < watched.length; start += 5) {
				if (this.runId !== runId || this.disposed) return;
				const batch = watched.slice(start, start + 5);
				const snapshots = await Promise.all(batch.map(async (tracked) => {
					const id = tracked.row.dispatchId;
					const capture = await runOrcaCli(this.deps.orcaBin, ["orchestration", "worker-read", "--dispatch", id, "--limit", "40", "--json"], { cwd: this.deps.cwd, env: this.deps.env, timeoutMs: 5_000 });
					const result = resultOf(capture);
					const terminal = result && typeof result.terminal === "object" && result.terminal ? (result.terminal as Record<string, unknown>) : undefined;
					const tail = Array.isArray(terminal?.tail) ? terminal.tail.filter((l): l is string => typeof l === "string").map(sanitizeTerminal) : undefined;
					return { tracked, tail };
				}));
				for (const { tracked, tail } of snapshots) {
					if (!tail) continue;
					const id = tracked.row.dispatchId;
					this.tails.set(id, tail);
					const statusModel = parsePiStatusModel(tail);
					const detail = this.details.get(id) ?? { agent: tracked.row.provider, model: "", effort: "", startedAt: null, reusedTerminal: false, worktreePath: tracked.row.workspacePath };
					if (!this.details.has(id)) this.details.set(id, detail);
					if (statusModel && (detail.statusModel?.provider !== statusModel.provider || detail.statusModel?.model !== statusModel.model || detail.statusModel?.thinking !== statusModel.thinking)) {
						this.details.set(id, { ...detail, statusModel });
						changed = true;
					}
					const line = lastActivity(tail);
					const text = line ? clip(redact(line), 200) : "";
					const prev = this.activity.get(id);
					if (text || prev) {
						const next = nextActivity(prev, text || prev!.text, this.deps.now(), tracked.row.activityAt ?? tracked.row.observedAt);
						if (prev?.text !== next.text || prev?.since !== next.since) changed = true;
						this.activity.set(id, next);
					}
				}
			}
			if (this.runId !== runId || this.disposed) return;
			const quiet = quietEvents(this.state, this.activity, this.deps.now(), this.deps.config ?? DEFAULT_FLEET_CONFIG);
			if (quiet.length) this.deps.onEvents(quiet, this.state, runId);
			if (this.deps.now() - this.watchdogLastScan >= this.watchdogConfig.cadenceMs) {
				await this.scanWatchdog(runId, this.deps.now());
			}
			if (changed || quiet.length) this.deps.onChange();
		} finally {
			this.readingActivity = false;
		}
	}

	private async scanWatchdog(runId: string, now: number): Promise<void> {
		if (this.runId !== runId || this.disposed) return;
		this.watchdogLastScan = now;
		if (!this.watchdogConfig.enabled) {
			this.watchdogState = evaluateWatchdog(this.watchdogState, [], now, this.watchdogConfig).state;
			await this.persistWatchdog();
			return;
		}
		const samples = [];
		for (const tracked of this.state.workers.values()) {
			const row = tracked.row;
			if (!isInProgress(row) && row.liveness !== "exited" && row.nextAction !== "release") continue;
			const taskSpec = this.state.tasks.get(row.taskId)?.spec ?? "";
			const policy = this.watchdogConfig.scopeGlobs.length ? this.watchdogConfig.scopeGlobs : parseAllowedEditSurfaces(taskSpec);
			let changedPaths: string[] | undefined = [];
			if (policy?.length && isInProgress(row)) {
				const worktree = this.details.get(row.dispatchId)?.worktreePath || row.workspacePath;
				if (worktree && isAbsolute(worktree)) {
					try {
						changedPaths = await gitChangedFiles(worktree);
					} catch {
						changedPaths = undefined;
					}
				} else changedPaths = undefined;
			}
			const detail = this.details.get(row.dispatchId);
			samples.push({
				dispatchId: row.dispatchId,
				title: this.state.tasks.get(row.taskId)?.title || row.taskId,
				taskSpec,
				activity: row.activity,
				outcome: row.outcome,
				liveness: row.liveness,
				ownership: row.ownership,
				nextAction: row.nextAction,
				terminalState: row.terminalState,
				activityAt: row.activityAt ?? row.observedAt,
				tail: this.tails.get(row.dispatchId) ?? [],
				changedPaths,
				requiresInput: row.attention.includes("input"),
				pendingQuestion: detail?.pendingQuestion || row.pendingQuestion,
				questionOptions: detail?.questionOptions || row.questionOptions,
				settledForMs: tracked.settledAt === null ? undefined : Math.max(0, now - tracked.settledAt),
			});
		}
		const result = evaluateWatchdog(this.watchdogState, samples, now, this.watchdogConfig);
		this.watchdogState = result.state;
		if (result.findings.length) {
			const events: FleetEvent[] = result.findings.map((finding) => ({
				kind: finding.kind,
				dispatchId: finding.dispatchId,
				taskId: this.state.workers.get(finding.dispatchId)?.row.taskId,
				title: finding.title,
				detail: finding.detail,
				sinceMs: finding.sinceMs,
				key: finding.key,
			}));
			this.deps.onEvents(events, this.state, runId);
		}
		await this.persistWatchdog();
	}

	async persist(): Promise<void> {
		await this.persistWatchdog();
	}

	/** Display-only reads; failures just leave the fields empty. */
	private async readDisplay(runId: string, rows: WorkerRow[]): Promise<void> {
		const opts = { cwd: this.deps.cwd, env: this.deps.env };
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
