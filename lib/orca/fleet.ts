// Fleet watch: model-free supervision of the Orca workers of the bound Run.
// Pure: parse `worker-list` / `task-list` output, diff snapshots, and decide
// which transitions deserve a notice to the coordinator model. The driver
// polls read-only (`worker-list --run`, `task-list --run`) and delivers the
// notices; the model decides what to do (user decision: no automatic nudges).
//
// Signals (Orca 1.4.212 projection):
//   stage.activity  working | done | idle | blocked | unknown   (agent hook)
//   outcome         in_progress | succeeded | failed | outcome_unknown | finished_unverified
//   liveness        live | unverifiable | exited
//   attention       categories + requiresAction
//   nextAction      none | release | recover | inspect

export interface WorkerRow {
	dispatchId: string;
	taskId: string;
	runId: string;
	workerState: string;
	dispatchStatus: string;
	terminalState: string;
	terminalHandle: string;
	activity: string;
	outcome: string;
	liveness: string;
	livenessReason: string;
	/** Last agent-status observation (ms epoch), when live. */
	observedAt: number | null;
	/** Latest heartbeat/status/message timestamp reported for this Dispatch. */
	activityAt?: number | null;
	attention: string[];
	requiresAction: boolean;
	nextAction: string;
	ownership: string;
	provider: string;
	workspacePath?: string;
	pendingQuestion?: string;
	questionOptions?: string[];
}

export interface TaskRow {
	id: string;
	title: string;
	/** What the worker was asked to do (`--spec`). */
	spec: string;
	status: string;
	deps: string[];
	parentId: string | null;
}

export interface WorkerPage {
	rows: WorkerRow[];
	hasMore: boolean;
	nextCursor: string | null;
}

const s = (v: unknown): string => (typeof v === "string" ? v : "");
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function parseWorkerRow(raw: unknown): WorkerRow | undefined {
	const row = rec(raw);
	const p = rec(row.projection);
	const stage = rec(p.stage);
	const live = rec(p.liveness);
	const attention = rec(p.attention);
	const resource = rec(row.resource);
	const dispatch = rec(row.dispatch);
	const workspace = rec(row.workspace);
	const worktree = rec(row.worktree);
	const pendingInput = rec(row.pendingInput ?? p.pendingInput);
	const questionThread = rec(row.questionThread ?? p.questionThread);
	const inputAttention = rec(attention.input);
	const latestMessage = rec(row.latestMessage);
	const dispatchId = s(row.dispatchId) || s(p.dispatchId);
	if (!dispatchId) return undefined;
	const observedAt = typeof live.observedAt === "number" ? live.observedAt : null;
	const activityTimes = [
		observedAt,
		...[[row, "lastHeartbeatAt"], [row, "heartbeatAt"], [row, "lastStatusAt"], [row, "statusAt"], [row, "lastMessageAt"], [row, "updatedAt"], [p, "lastHeartbeatAt"], [p, "lastStatusAt"], [p, "lastMessageAt"], [dispatch, "lastHeartbeatAt"], [dispatch, "heartbeatAt"], [dispatch, "lastStatusAt"], [dispatch, "statusAt"], [dispatch, "lastMessageAt"], [dispatch, "updatedAt"], [latestMessage, "createdAt"], [latestMessage, "sentAt"]].map(([source, key]) => {
			const value = (source as Record<string, unknown>)[key as string];
			return typeof value === "number" ? value : parseOrcaTime(value);
		}),
	].filter((value): value is number => value !== null);
	return {
		dispatchId,
		taskId: s(row.taskId) || s(p.taskId),
		runId: s(row.runId) || s(p.runId),
		workerState: s(row.workerState) || s(stage.worker),
		dispatchStatus: s(row.dispatchStatus) || s(stage.dispatch),
		terminalState: s(row.terminalState),
		terminalHandle: s(row.agentTerminalHandle),
		activity: s(stage.activity) || "unknown",
		outcome: s(p.outcome) || "in_progress",
		liveness: s(live.verdict) || "unverifiable",
		livenessReason: s(live.reason),
		observedAt,
		activityAt: activityTimes.length ? Math.max(...activityTimes) : null,
		attention: Array.isArray(attention.categories) ? attention.categories.filter((c): c is string => typeof c === "string") : [],
		requiresAction: attention.requiresAction === true,
		nextAction: s(rec(p.nextAction).kind) || "none",
		ownership: s(resource.ownershipState),
		provider: s(rec(p.provider).id),
		workspacePath: s(row.workspacePath) || s(row.worktreePath) || s(row.cwd) || s(workspace.path) || s(worktree.path) || s(resource.workspacePath) || undefined,
		pendingQuestion: s(row.pendingQuestion) || s(pendingInput.question) || s(pendingInput.text) || s(questionThread.question) || s(inputAttention.question) || s(inputAttention.prompt) || undefined,
		questionOptions: readOptions(pendingInput.options) ?? readOptions(questionThread.options) ?? readOptions(inputAttention.options),
	};
}

/** Display-only facts about one Dispatch, read once from `worker-show`. */
export interface WorkerDetail {
	agent: string;
	/** Model passed with `--model`; empty when the agent uses its own default. */
	model: string;
	/** Provider from the effective launch options, when explicit model evidence exists. */
	provider?: string;
	/** Thinking level actually passed to the launched model. */
	effort: string;
	/** Model observed in the worker's live Pi status bar. */
	statusModel?: { provider?: string; model: string; thinking?: string };
	/** Local worker worktree path, when Orca reports one. */
	worktreePath?: string;
	/** Pending Orca ask content when exposed by worker-show. */
	pendingQuestion?: string;
	questionOptions?: string[];
	/** When the worker was dispatched (ms epoch), if known. */
	startedAt: number | null;
	/** Dispatched into an existing terminal (`--terminal`): Orca did not launch the agent. */
	reusedTerminal: boolean;
}

/** Orca prints SQLite UTC timestamps without a zone ("2026-09-27 16:15:16"). */
export function parseOrcaTime(v: unknown): number | null {
	if (typeof v !== "string" || !v) return null;
	const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v.replace(" ", "T")}Z`;
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : null;
}

export function parseWorkerShow(result: Record<string, unknown>): WorkerDetail {
	const worker = rec(result.worker);
	const dispatch = rec(result.dispatch);
	const opts = rec(worker.startOptions);
	const launch = rec(opts.launch);
	const eff = rec(launch.effective);
	const req = rec(launch.requested);
	const workspace = rec(worker.workspace);
	const worktree = rec(worker.worktree);
	const resource = rec(worker.resource);
	const observation = rec(result.observation);
	const pendingInput = rec(dispatch.pendingInput ?? worker.pendingInput ?? result.pendingInput ?? observation.pendingInput);
	const questionThread = rec(dispatch.questionThread ?? worker.questionThread ?? result.questionThread);
	const waitingQuestion = rec(observation.agentWait);
	const pendingQuestion = s(result.pendingQuestion) || s(result.question) || s(dispatch.pendingQuestion) || s(pendingInput.question) || s(pendingInput.text) || s(questionThread.question) || s(waitingQuestion.question) || s(waitingQuestion.prompt) || s(waitingQuestion.promptText);
	const questionOptions = readOptions(pendingInput.options) ?? readOptions(questionThread.options) ?? readOptions(waitingQuestion.options);
	const requestedModel = s(req.model);
	const commandModel = explicitModelFlag(launch.command) || explicitModelFlag(opts.command) || explicitModelFlag(worker.command);
	const commandThinking = explicitFlag(launch.command, "thinking") || explicitFlag(opts.command, "thinking") || explicitFlag(worker.command, "thinking") || explicitFlag(launch.command, "effort") || explicitFlag(opts.command, "effort") || explicitFlag(worker.command, "effort");
	const model = requestedModel ? s(eff.model) || requestedModel : commandModel || "";
	const thinking = model ? s(eff.thinkingLevel) || s(eff.thinking) || s(eff.effort) || s(req.thinkingLevel) || s(req.effort) || commandThinking : "";
	const provider = model ? s(eff.provider) || s(req.provider) : "";
	return {
		agent: s(eff.agent) || s(req.agent) || s(opts.agent),
		model,
		...(provider ? { provider } : {}),
		effort: thinking,
		...(pendingQuestion ? { pendingQuestion } : {}),
		...(questionOptions ? { questionOptions } : {}),
		...((s(worker.workspacePath) || s(worker.worktreePath) || s(worker.cwd) || s(workspace.path) || s(worktree.path) || s(resource.workspacePath)) ? { worktreePath: s(worker.workspacePath) || s(worker.worktreePath) || s(worker.cwd) || s(workspace.path) || s(worktree.path) || s(resource.workspacePath) } : {}),
		startedAt: parseOrcaTime(dispatch.dispatchedAt) ?? parseOrcaTime(dispatch.createdAt) ?? parseOrcaTime(worker.createdAt),
		reusedTerminal: Boolean(s(opts.terminal)),
	};
}

function readOptions(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const options = value.map((item) => {
		if (typeof item === "string") return item;
		const option = rec(item);
		return s(option.label) || s(option.title) || s(option.text) || s(option.value);
	}).filter(Boolean);
	return options.length ? options : undefined;
}

function explicitModelFlag(command: unknown): string {
	return explicitFlag(command, "model");
}

function explicitFlag(command: unknown, name: string): string {
	const flag = `--${name}`;
	if (Array.isArray(command)) {
		const index = command.indexOf(flag);
		if (index >= 0 && typeof command[index + 1] === "string") return command[index + 1];
		const inline = command.find((arg) => typeof arg === "string" && arg.startsWith(`${flag}=`));
		return typeof inline === "string" ? inline.slice(flag.length + 1) : "";
	}
	if (typeof command !== "string") return "";
	return new RegExp(`(?:^|\\s)${flag}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|(\\S+))`).exec(command)?.slice(1).find(Boolean) ?? "";
}

export function parseWorkerPage(result: Record<string, unknown>): WorkerPage {
	const workers = Array.isArray(result.workers) ? result.workers : [];
	const page = rec(result.page);
	return {
		rows: workers.map(parseWorkerRow).filter((r): r is WorkerRow => r !== undefined),
		hasMore: page.hasMore === true,
		nextCursor: typeof page.nextCursor === "string" ? page.nextCursor : null,
	};
}

export function parseTasks(result: Record<string, unknown>): TaskRow[] {
	const tasks = Array.isArray(result.tasks) ? result.tasks : [];
	return tasks
		.map((raw) => {
			const t = rec(raw);
			let deps: string[] = [];
			try {
				const parsed = typeof t.deps === "string" ? JSON.parse(t.deps) : t.deps;
				if (Array.isArray(parsed)) deps = parsed.filter((d): d is string => typeof d === "string");
			} catch {
				deps = [];
			}
			return { id: s(t.id), title: s(t.display_name) || s(t.task_title), spec: s(t.spec), status: s(t.status), deps, parentId: s(t.parent_id) || null };
		})
		.filter((t) => t.id);
}

export const IN_PROGRESS = "in_progress";
export const SETTLED_OUTCOMES = new Set(["succeeded", "failed"]);

export function isInProgress(row: WorkerRow): boolean {
	return row.outcome === IN_PROGRESS && row.liveness !== "exited" && !["succeeded", "failed", "stopped", "abandoned", "released"].includes(row.workerState);
}

/** A human typed into the worker terminal; do not report it as stalled. */
export function humanOwned(row: WorkerRow): boolean {
	return row.ownership === "user_owned";
}

export type FleetEventKind = "stalled" | "quiet" | "blocked" | "exited" | "attention" | "settled" | "release" | "ready_tasks" | "fleet_idle" | "resumed" | "scope" | "stall" | "loop" | "prompt" | "finished";

export interface FleetEvent {
	kind: FleetEventKind;
	dispatchId?: string;
	taskId?: string;
	title?: string;
	/** How long the condition has held, ms. */
	sinceMs?: number;
	detail?: string;
	/** orca_watch notes attached to this dispatch. */
	notes?: string[];
	/** Dedup key of the condition (persisted so a reload does not repeat it). */
	key?: string;
}

export interface FleetConfig {
	stallMs: number;
	/** A working agent whose activity has not changed this long is reported once. */
	quietMs: number;
	blockedMs: number;
	releaseGraceMs: number;
}

export const DEFAULT_FLEET_CONFIG: FleetConfig = { stallMs: 3 * 60_000, quietMs: 10 * 60_000, blockedMs: 60_000, releaseGraceMs: 3 * 60_000 };

export type WatchOn = "settled" | "stalled" | "blocked" | "any";

export interface Watch {
	dispatchId: string;
	on: WatchOn[];
	note: string;
	createdAt: number;
}

interface Tracked {
	row: WorkerRow;
	/** When the current activity value was first seen (or observedAt). */
	activitySince: number;
	settledAt: number | null;
	/** Condition keys already notified, so each episode is reported once. */
	notified: Set<string>;
}

export interface FleetState {
	workers: Map<string, Tracked>;
	tasks: Map<string, TaskRow>;
	watches: Watch[];
	/** Key of the last fleet-level notice (idle / ready tasks). */
	fleetKey: string;
	/** First poll only records the baseline for settled history. */
	primed: boolean;
	/** Keys already notified before a reload, per dispatch; consumed on first sighting. */
	seen: Map<string, string[]>;
}

export function initialFleet(): FleetState {
	return { workers: new Map(), tasks: new Map(), watches: [], fleetKey: "", primed: false, seen: new Map() };
}

const STALL_ACTIVITIES = new Set(["done", "idle"]);

function activityStart(prev: Tracked | undefined, row: WorkerRow, now: number): number {
	const activityAt = row.activityAt ?? row.observedAt;
	if (prev && prev.row.activity === row.activity) {
		// Heartbeat/status messages are evidence of operator activity even when
		// the activity label itself (for example `working`) has not changed.
		return activityAt !== null && activityAt !== undefined && activityAt > prev.activitySince && activityAt <= now ? activityAt : prev.activitySince;
	}
	// The newest hook/message timestamp survives reloads and gives a better
	// stall baseline than the time this coordinator happened to poll.
	if (activityAt !== null && activityAt !== undefined && activityAt <= now) return activityAt;
	return now;
}

function titleOf(state: FleetState, row: WorkerRow): string {
	return state.tasks.get(row.taskId)?.title || row.taskId || row.dispatchId;
}

export interface FleetUpdate {
	state: FleetState;
	events: FleetEvent[];
}

/**
 * Diff one complete poll against the previous state. `rows` must be the
 * whole Run (all pages); `tasks` may be undefined when not refreshed.
 */
export function updateFleet(prev: FleetState, rows: WorkerRow[], tasks: TaskRow[] | undefined, now: number, config: FleetConfig = DEFAULT_FLEET_CONFIG): FleetUpdate {
	const state: FleetState = {
		workers: new Map(),
		tasks: tasks ? new Map(tasks.map((t) => [t.id, t])) : prev.tasks,
		watches: prev.watches,
		fleetKey: prev.fleetKey,
		primed: true,
		seen: prev.seen,
	};
	const events: FleetEvent[] = [];
	const push = (tracked: Tracked, kind: FleetEventKind, key: string, extra: Partial<FleetEvent> = {}) => {
		if (tracked.notified.has(key)) return;
		tracked.notified.add(key);
		// On the first poll, only current problems are reported, not history.
		if (!prev.primed && (kind === "settled" || kind === "resumed")) return;
		events.push({ kind, dispatchId: tracked.row.dispatchId, taskId: tracked.row.taskId, title: titleOf(state, tracked.row), key, ...extra });
	};

	for (const row of rows) {
		const old = prev.workers.get(row.dispatchId);
		const tracked: Tracked = {
			row,
			activitySince: activityStart(old, row, now),
			settledAt: old?.settledAt ?? null,
			notified: new Set([...(old?.notified ?? []), ...(old ? [] : (prev.seen.get(row.dispatchId) ?? []))]),
		};
		state.workers.set(row.dispatchId, tracked);
		const active = isInProgress(row);
		const age = now - tracked.activitySince;

		if (!active && tracked.settledAt === null) tracked.settledAt = now;
		if (active) tracked.settledAt = null;

		if (active && !humanOwned(row)) {
			if (STALL_ACTIVITIES.has(row.activity) && age >= config.stallMs) {
				push(tracked, "stalled", `stalled:${tracked.activitySince}`, { sinceMs: age, detail: `activity ${row.activity}, no worker_done` });
			}
			// Orca drops activity to `unknown` after 30 min without a status post.
			if (row.liveness === "unverifiable" && row.livenessReason === "stale_status") {
				push(tracked, "stalled", "stale_status", { detail: "no agent status for over 30 min (liveness stale), no worker_done" });
			}
			if (row.activity === "blocked" && age >= config.blockedMs) {
				push(tracked, "blocked", `blocked:${tracked.activitySince}`, { sinceMs: age, detail: "waiting on an interactive prompt in its terminal" });
			}
			// A stalled or blocked worker that starts working again is worth one line.
			if (row.activity === "working" && old && (old.notified.has(`stalled:${old.activitySince}`) || old.notified.has(`blocked:${old.activitySince}`)) && old.row.activity !== "working") {
				push(tracked, "resumed", `resumed:${tracked.activitySince}`, { detail: "working again" });
			}
			const actionable = row.attention.filter((c) => ["guidance", "input", "approval", "failure", "interruption"].includes(c));
			if (row.requiresAction && actionable.length) push(tracked, "attention", `attention:${actionable.sort().join(",")}`, { detail: actionable.join(", ") });
		}
		if (row.outcome === IN_PROGRESS && row.liveness === "exited") {
			push(tracked, "exited", "exited", { detail: `process exited without worker_done (nextAction ${row.nextAction})` });
		}
		if (old && isInProgress(old.row) && !active && SETTLED_OUTCOMES.has(row.outcome)) {
			push(tracked, "settled", `settled:${row.outcome}`, { detail: row.outcome });
		}
		// A terminal a human took over is theirs, not closure debt.
		if (row.nextAction === "release" && !humanOwned(row) && tracked.settledAt !== null && now - tracked.settledAt >= config.releaseGraceMs) {
			push(tracked, "release", "release", { detail: "settled but its terminal is not released" });
		}
	}

	// Watches: attach notes to matching events; `any` also reports settles and
	// activity changes; a watch ends when its dispatch settles.
	const remaining: Watch[] = [];
	for (const watch of state.watches) {
		const tracked = state.workers.get(watch.dispatchId);
		const matching = events.filter((e) => e.dispatchId === watch.dispatchId && (watch.on.includes("any") || watch.on.includes(e.kind as WatchOn)));
		for (const e of matching) e.notes = [...(e.notes ?? []), watch.note].filter(Boolean);
		if (watch.on.includes("any") && tracked) {
			const old = prev.workers.get(watch.dispatchId);
			if (old && old.row.activity !== tracked.row.activity && !matching.length) {
				events.push({ kind: "resumed", dispatchId: watch.dispatchId, taskId: tracked.row.taskId, title: titleOf(state, tracked.row), detail: `activity ${old.row.activity} → ${tracked.row.activity}`, notes: watch.note ? [watch.note] : [] });
			}
		}
		// A settled watch fires once through the settled event, then ends.
		if (tracked && !isInProgress(tracked.row)) {
			if (watch.on.includes("settled") || watch.on.includes("any")) {
				if (!events.some((e) => e.dispatchId === watch.dispatchId && e.kind === "settled") && prev.primed) {
					events.push({ kind: "settled", dispatchId: watch.dispatchId, taskId: tracked.row.taskId, title: titleOf(state, tracked.row), detail: tracked.row.outcome, notes: watch.note ? [watch.note] : [] });
				}
			}
			continue;
		}
		remaining.push(watch);
	}
	state.watches = remaining;

	// Fleet level: nobody working while work is still open.
	const open = [...state.workers.values()].filter((t) => isInProgress(t.row));
	const working = open.filter((t) => t.row.activity === "working");
	const ready = readyTasks(state);
	const idleOpen = open.length > 0 && working.length === 0 && open.every((t) => now - t.activitySince >= config.stallMs);
	const fleetKey = idleOpen ? `idle:${open.map((t) => `${t.row.dispatchId}@${t.activitySince}`).sort().join(",")}` : ready.length && working.length === 0 && open.length === 0 ? `ready:${ready.map((t) => t.id).sort().join(",")}` : "";
	if (fleetKey && fleetKey !== prev.fleetKey) {
		if (idleOpen) events.push({ kind: "fleet_idle", key: fleetKey, detail: `${open.length} open worker${open.length === 1 ? "" : "s"}, none working` });
		else events.push({ kind: "ready_tasks", key: fleetKey, detail: `${ready.length} ready task${ready.length === 1 ? "" : "s"} without a worker: ${ready.map((t) => t.title || t.id).slice(0, 5).join(", ")}` });
	}
	state.fleetKey = fleetKey;
	return { state, events };
}

/** Pending tasks whose dependencies are completed and that have no dispatch. */
export function readyTasks(state: FleetState): TaskRow[] {
	const dispatched = new Set([...state.workers.values()].map((t) => t.row.taskId));
	return [...state.tasks.values()].filter(
		(t) => (t.status === "pending" || t.status === "ready") && !dispatched.has(t.id) && t.deps.every((d) => state.tasks.get(d)?.status === "completed"),
	);
}

/**
 * Working agents whose live activity (see activity.ts) has not changed for
 * `quietMs`: the same command or line for too long. Each quiet episode is
 * reported once; waiting on the agent's own background task does not count.
 * Mutates `notified` of the tracked workers it reports.
 */
export function quietEvents(state: FleetState, activity: Map<string, { text: string; since: number }>, now: number, config: FleetConfig = DEFAULT_FLEET_CONFIG): FleetEvent[] {
	const events: FleetEvent[] = [];
	for (const tracked of state.workers.values()) {
		const r = tracked.row;
		const seen = activity.get(r.dispatchId);
		if (!seen || !isInProgress(r) || r.activity !== "working" || humanOwned(r) || seen.text.startsWith("⏵ ")) continue;
		const quiet = now - seen.since;
		if (quiet < config.quietMs) continue;
		const key = `quiet:${seen.since}`;
		if (tracked.notified.has(key)) continue;
		tracked.notified.add(key);
		events.push({ kind: "quiet", dispatchId: r.dispatchId, taskId: r.taskId, title: titleOf(state, r), sinceMs: quiet, detail: `still at: ${seen.text}`, notes: state.watches.filter((w) => w.dispatchId === r.dispatchId && (w.on.includes("stalled") || w.on.includes("any")) && w.note).map((w) => w.note), key });
	}
	return events;
}

/** Seed notified keys recorded before a reload (fleet-level key included). */
export function seedSeen(state: FleetState, seen: Array<{ dispatchId?: string; key: string }>): FleetState {
	const map = new Map(state.seen);
	let fleetKey = state.fleetKey;
	for (const entry of seen) {
		if (!entry.dispatchId) {
			fleetKey = entry.key;
			continue;
		}
		map.set(entry.dispatchId, [...(map.get(entry.dispatchId) ?? []), entry.key].slice(-50));
	}
	return { ...state, seen: map, fleetKey };
}

export function addWatch(state: FleetState, watch: Watch): FleetState {
	const others = state.watches.filter((w) => !(w.dispatchId === watch.dispatchId && w.note === watch.note));
	return { ...state, watches: [...others, watch].slice(-50) };
}

export interface FleetSummary {
	open: number;
	working: number;
	stalled: number;
	blocked: number;
	toRelease: number;
	readyTasks: number;
	humanOwned: number;
	/** Open workers without an agent-status hook (e.g. non-Pi agents): Orca reports activity unknown. */
	noStatus: number;
}

export function summarize(state: FleetState, now: number, config: FleetConfig = DEFAULT_FLEET_CONFIG): FleetSummary {
	const all = [...state.workers.values()];
	const open = all.filter((t) => isInProgress(t.row));
	return {
		open: open.length,
		working: open.filter((t) => t.row.activity === "working").length,
		stalled: open.filter((t) => ((STALL_ACTIVITIES.has(t.row.activity) && now - t.activitySince >= config.stallMs) || t.row.livenessReason === "stale_status") && !humanOwned(t.row)).length,
		blocked: open.filter((t) => t.row.activity === "blocked").length,
		toRelease: all.filter((t) => t.row.nextAction === "release").length,
		readyTasks: readyTasks(state).length,
		humanOwned: open.filter((t) => humanOwned(t.row)).length,
		noStatus: open.filter((t) => t.row.activity === "unknown" && t.row.livenessReason !== "stale_status").length,
	};
}

export function summaryLine(sum: FleetSummary): string {
	const parts = [`${sum.open} open`, `${sum.working} working`];
	if (sum.stalled) parts.push(`${sum.stalled} stalled`);
	if (sum.blocked) parts.push(`${sum.blocked} blocked`);
	if (sum.humanOwned) parts.push(`${sum.humanOwned} human-driven`);
	if (sum.noStatus) parts.push(`${sum.noStatus} without status`);
	if (sum.toRelease) parts.push(`${sum.toRelease} to release`);
	if (sum.readyTasks) parts.push(`${sum.readyTasks} ready task${sum.readyTasks === 1 ? "" : "s"}`);
	return parts.join(" · ");
}
