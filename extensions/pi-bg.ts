// pi-bg: background tasks that wake the model when they finish, a first-class
// bridge to the Orca orchestration mailbox for coordinator sessions, a
// model-free fleet watch of the Run's workers, and a worker-side reminder.
// See README.md and docs/manual-test-plan.md.
//
// Wake delivery uses custom messages with `deliverAs: "steer"` and
// `triggerTurn: true`: an idle session starts a turn at once; a busy one
// sees the message before its next model call. `followUp` is avoided on
// purpose (it waits for the whole run to stop).

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { OrcaBridge, pruneOld } from "../lib/orca/bridge.ts";
import { formatDelivery, heartbeatCount, typeSummary, type Delivery } from "../lib/orca/delivery.ts";
import { FleetWatch } from "../lib/orca/fleet-driver.ts";
import { formatFleetNotice, formatWorkersTable, shouldWake } from "../lib/orca/fleet-format.ts";
import type { FleetEvent, FleetState, WatchOn } from "../lib/orca/fleet.ts";
import { BLOCK_REASON, classifyOrcaCommand } from "../lib/orca/guard.ts";
import { acceptedByOrca, initialWorker, onInput, onLifecycleResult, reminderFor, type WorkerState } from "../lib/orca/worker.ts";
import { redact } from "../lib/redact.ts";
import { stateBlock } from "../lib/state-block.ts";
import { footerText } from "../lib/status.ts";
import { TaskManager, type TaskSnapshot } from "../lib/tasks/manager.ts";
import { formatNotices, type TaskNotice } from "../lib/tasks/notice.ts";
import { clip, formatDuration, sanitizeTerminal } from "../lib/text.ts";
import { buildCard, renderCardLines } from "../lib/ui/card.ts";
import { deliveryView, messageFacts, type MessageFact } from "../lib/ui/delivery-view.ts";
import { createWakeBudget, takeWake } from "../lib/wake-budget.ts";

const TASK_MESSAGE = "pi-bg-task";
const ORCA_MESSAGE = "pi-bg-orca";
const FLEET_MESSAGE = "pi-bg-fleet";
const WORKER_MESSAGE = "pi-bg-worker";
const WATCH_ENTRY = "pi-bg-watch";
const FLEET_SEEN_ENTRY = "pi-bg-fleet-seen";
const STATUS_KEY = "pi-bg";
const CARD_KEY = "pi-bg-card";
const NOTICE_BATCH_MS = 400;
const FLEET_BATCH_MS = 5_000;
const WATCH_DEFAULT_TIMEOUT_S = 30 * 60;
const MAX_TIMEOUT_S = 24 * 3600;
const ORCA_TOOLS = ["orca_ack", "orca_inbox", "orca_workers", "orca_watch"];

function stateDir(env: NodeJS.ProcessEnv): string {
	if (env.PI_BG_STATE_DIR) return env.PI_BG_STATE_DIR;
	return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi-bg");
}

const clean = (text: string): string => redact(sanitizeTerminal(text));

function describeTask(t: TaskSnapshot, now: number): string {
	const age = formatDuration((t.endedAt ?? now) - t.startedAt);
	const exit = t.status === "running" ? "" : t.signal ? ` (${t.signal})` : t.exitCode !== null ? ` (exit ${t.exitCode})` : "";
	const watch = t.watch ? ` · watch /${clean(t.watch.pattern)}/ ${t.watch.mode ?? "until"}${t.watchEvents ? ` ${t.watchEvents} hit${t.watchEvents === 1 ? "" : "s"}` : ""}` : "";
	const label = t.label !== t.id ? `"${clip(clean(t.label), 60)}" · ` : "";
	const logError = t.logError ? ` · log error: ${t.logError}` : "";
	return `${t.id} ${t.status}${exit} ${age} · ${label}${clip(clean(t.command), 120)}${watch}${logError}\n   log: ${t.logPath}`;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text?: unknown }).text ?? "") : "")).join("\n");
	return "";
}

/** One-line tool results unless expanded (bg_* and orca_* tools). */
function compactResult(result: { content: Array<{ type: string; text?: string }> }, options: { expanded: boolean }, theme: { fg(c: string, t: string): string }) {
	const text = sanitizeTerminal(result.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n")).trim();
	const [first, ...rest] = text.split("\n");
	const more = !options.expanded && rest.length ? theme.fg("dim", ` (+${rest.length} lines)`) : "";
	return new Text(options.expanded ? theme.fg("toolOutput", text) : `${theme.fg("toolOutput", first ?? "")}${more}`, 0, 0);
}

export default function piBg(pi: ExtensionAPI) {
	if (process.env.PI_BG_DISABLE === "1") return;

	const env = process.env;
	const root = stateDir(env);
	const inOrcaTerminal = Boolean(env.ORCA_TERMINAL_HANDLE) && env.PI_BG_ORCA !== "0";
	const gentleChild = env.GENTLE_PI_AGENTS_CHILD === "1";
	// Subagent children inherit the terminal identity; only the lead may consume.
	const orcaEnabled = inOrcaTerminal && !gentleChild;

	let ctxRef: ExtensionContext | undefined;
	let manager: TaskManager | undefined;
	let bridge: OrcaBridge | undefined;
	let fleet: FleetWatch | undefined;
	let worker: WorkerState = initialWorker();
	let noticeQueue: TaskNotice[] = [];
	let noticeTimer: ReturnType<typeof setTimeout> | undefined;
	let fleetQueue: FleetEvent[] = [];
	let fleetTimer: ReturnType<typeof setTimeout> | undefined;
	let wakeBudget = createWakeBudget();
	let exitHook: (() => void) | undefined;
	let tickTimer: ReturnType<typeof setInterval> | undefined;
	let cardTui: TUI | undefined;
	let cardMode: "on" | "collapsed" | "off" = env.PI_BG_CARD === "off" ? "off" : "on";
	let orcaToolsActive: boolean | undefined;
	let active = false;

	const now = () => Date.now();
	const bridgeOwnsMailbox = (): boolean => Boolean(bridge && bridge.state.phase !== "off" && bridge.state.phase !== "fenced");

	const liveState = () => stateBlock({ now: now(), tasks: manager?.list() ?? [], orca: bridge?.state, fleet: fleet?.state, fleetIncomplete: fleet?.incomplete });

	/** Orca coordinator tools exist only while a Run is bound (workers keep their preamble's `check`). */
	const syncOrcaTools = () => {
		if (!orcaEnabled) return;
		const want = bridgeOwnsMailbox() || bridge?.state.phase === "fenced";
		if (orcaToolsActive === want) return;
		orcaToolsActive = want;
		try {
			const current = pi.getActiveTools().filter((name) => !ORCA_TOOLS.includes(name));
			pi.setActiveTools(want ? [...current, ...ORCA_TOOLS] : current);
		} catch {
			/* best effort */
		}
	};

	const syncFleet = () => {
		if (!fleet || !bridge) return;
		const s = bridge.state;
		if (s.runId && s.phase !== "off" && s.phase !== "fenced") fleet.watch(s.runId);
		else fleet.stop();
	};

	const refresh = () => {
		syncOrcaTools();
		syncFleet();
		const ctx = ctxRef;
		if (!ctx?.hasUI) return;
		try {
			ctx.ui.setStatus(STATUS_KEY, footerText(manager?.running().length ?? 0, bridge?.state, now()));
		} catch {
			/* UI may be gone during shutdown */
		}
		cardTui?.requestRender();
	};

	// ---- wake messages ----------------------------------------------------

	const flushNotices = () => {
		noticeTimer = undefined;
		if (!active || noticeQueue.length === 0) return;
		const batch = noticeQueue;
		noticeQueue = [];
		const state = liveState();
		pi.sendMessage(
			{
				customType: TASK_MESSAGE,
				content: formatNotices(batch) + (state ? `\n\n${state}` : ""),
				display: true,
				details: { tasks: batch.map((n) => ({ id: n.id, kind: n.kind, exitCode: n.exitCode, signal: n.signal, stillRunning: n.stillRunning })) },
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	};

	const queueNotice = (notice: TaskNotice) => {
		if (!active) return;
		noticeQueue.push(notice);
		if (!noticeTimer) {
			noticeTimer = setTimeout(flushNotices, NOTICE_BATCH_MS);
			noticeTimer.unref?.();
		}
	};

	const injectDelivery = (delivery: Delivery, note: string | undefined, rawPath: string | undefined) => {
		if (!active) return;
		pi.sendMessage(
			{
				customType: ORCA_MESSAGE,
				content: formatDelivery(delivery, { note, rawPath }),
				display: true,
				details: { deliveryId: delivery.id, runId: delivery.runId, types: typeSummary(delivery), replay: Boolean(note), heartbeats: heartbeatCount(delivery), messages: messageFacts(delivery) },
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	};

	const remindDelivery = (delivery: Delivery) => {
		if (!active) return;
		pi.sendMessage(
			{
				customType: ORCA_MESSAGE,
				content: `Orca delivery ${delivery.id} has been pending for over 10 minutes. The Run mailbox is paused until it is acknowledged: finish processing it and call orca_ack with deliveryId "${delivery.id}", or tell the user what blocks it. orca_inbox shows it again.`,
				display: true,
				details: { deliveryId: delivery.id, runId: delivery.runId, reminder: true },
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	};

	const flushFleet = () => {
		fleetTimer = undefined;
		if (!active || !fleet || fleetQueue.length === 0) return;
		const events = fleetQueue;
		fleetQueue = [];
		const runId = fleet.runId ?? "?";
		// Remember what was reported so a /reload does not report it again.
		const seen = events.filter((e) => e.key).map((e) => ({ ...(e.dispatchId ? { dispatchId: e.dispatchId } : {}), key: e.key as string }));
		if (seen.length) pi.appendEntry(FLEET_SEEN_ENTRY, { runId, seen });
		const wake = shouldWake(events);
		let trigger = false;
		if (wake) {
			const taken = takeWake(wakeBudget, now());
			wakeBudget = taken.budget;
			trigger = taken.allowed;
		}
		const state = liveState();
		const suffix = wake && !trigger ? "\n(Several fleet notices in a short time: this one did not start a turn.)" : "";
		pi.sendMessage(
			{
				customType: FLEET_MESSAGE,
				content: formatFleetNotice(events, fleet.state, runId, now()) + suffix + (state ? `\n\n${state}` : ""),
				display: true,
				details: { runId, events: events.map((e) => ({ kind: e.kind, dispatchId: e.dispatchId, title: e.title })) },
			},
			trigger ? { deliverAs: "steer", triggerTurn: true } : { deliverAs: "nextTurn" },
		);
	};

	const queueFleet = (events: FleetEvent[], _state: FleetState, _runId: string) => {
		if (!active) return;
		fleetQueue.push(...events);
		if (!fleetTimer) {
			fleetTimer = setTimeout(flushFleet, FLEET_BATCH_MS);
			fleetTimer.unref?.();
		}
	};

	// ---- lifecycle -------------------------------------------------------

	pi.on("session_start", (_event, ctx) => {
		ctxRef = ctx;
		if (active) return;
		active = true;
		worker = initialWorker();
		wakeBudget = createWakeBudget();
		orcaToolsActive = undefined;
		const sessionId = ctx.sessionManager.getSessionId?.() || "session";
		manager = new TaskManager({
			logDir: join(root, "logs", sessionId.replace(/[^A-Za-z0-9_-]/g, "_")),
			now,
			onNotice: queueNotice,
			onChange: refresh,
			onLifecycle: (id, phase) => {
				// Orca's Pi status extension keeps the pane "working" while child work is live.
				if (!inOrcaTerminal) return;
				try {
					pi.events.emit(phase === "started" ? "subagent:async-started" : "subagent:async-complete", { id: `pi-bg:${sessionId}:${id}` });
				} catch {
					/* no listener */
				}
			},
		});
		void pruneOldLogs(join(root, "logs"));
		if (orcaEnabled && ctx.mode === "tui") {
			fleet = new FleetWatch({ orcaBin: env.PI_BG_ORCA_BIN || "orca", cwd: ctx.cwd, env, now, onEvents: queueFleet, onChange: refresh });
			restoreWatches(ctx);
			bridge = new OrcaBridge({
				orcaBin: env.PI_BG_ORCA_BIN || "orca",
				cwd: ctx.cwd,
				env,
				rawDir: join(root, "orca"),
				now,
				inject: injectDelivery,
				remind: remindDelivery,
				onChange: refresh,
			});
			bridge.start();
		}
		if (ctx.hasUI && ctx.mode === "tui") installCard(ctx);
		tickTimer = setInterval(() => cardTui?.requestRender(), 5_000);
		tickTimer.unref?.();
		const onExit = () => {
			manager?.killAllSync();
			bridge?.killSync();
		};
		exitHook = onExit;
		process.once("exit", onExit);
		refresh();
	});

	pi.on("session_shutdown", async () => {
		if (!active) return;
		active = false;
		for (const timer of [noticeTimer, fleetTimer]) if (timer) clearTimeout(timer);
		if (tickTimer) clearInterval(tickTimer);
		noticeTimer = fleetTimer = tickTimer = undefined;
		noticeQueue = [];
		fleetQueue = [];
		fleet?.dispose();
		bridge?.dispose();
		await manager?.shutdown();
		if (exitHook) process.removeListener("exit", exitHook);
		exitHook = undefined;
		try {
			ctxRef?.ui.setStatus(STATUS_KEY, undefined);
			ctxRef?.ui.setWidget(CARD_KEY, undefined);
		} catch {
			/* ignore */
		}
		cardTui = undefined;
		fleet = undefined;
		bridge = undefined;
		manager = undefined;
	});

	function restoreWatches(ctx: ExtensionContext) {
		try {
			const seenByRun = new Map<string, Array<{ dispatchId?: string; key: string }>>();
			let lastRun: string | undefined;
			for (const entry of ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown }>) {
				if (entry.type !== "custom" || entry.customType !== FLEET_SEEN_ENTRY) continue;
				const d = entry.data as { runId?: unknown; seen?: unknown } | undefined;
				if (!d || typeof d.runId !== "string" || !Array.isArray(d.seen)) continue;
				lastRun = d.runId;
				seenByRun.set(d.runId, [...(seenByRun.get(d.runId) ?? []), ...(d.seen as Array<{ dispatchId?: string; key: string }>)].slice(-500));
			}
			if (lastRun) fleet?.seed(lastRun, seenByRun.get(lastRun) ?? []);
		} catch {
			/* older sessions */
		}
		try {
			for (const entry of ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown }>) {
				if (entry.type !== "custom" || entry.customType !== WATCH_ENTRY) continue;
				const w = entry.data as { dispatchId?: unknown; on?: unknown; note?: unknown; createdAt?: unknown } | undefined;
				if (!w || typeof w.dispatchId !== "string") continue;
				fleet?.addWatch({ dispatchId: w.dispatchId, on: Array.isArray(w.on) ? (w.on as WatchOn[]) : ["settled"], note: typeof w.note === "string" ? w.note : "", createdAt: typeof w.createdAt === "number" ? w.createdAt : now() });
			}
		} catch {
			/* older sessions */
		}
	}

	function installCard(ctx: ExtensionContext) {
		if (cardMode === "off") {
			ctx.ui.setWidget(CARD_KEY, undefined);
			return;
		}
		ctx.ui.setWidget(CARD_KEY, (tui, theme) => {
			cardTui = tui;
			return {
				render(width: number) {
					const m = manager;
					if (!m) return [];
					const tasks = m.list();
					const lastLinesMap = new Map<string, string>();
					for (const t of tasks) {
						const line = t.status === "running" ? m.lastLine(t.id) : undefined;
						if (line) lastLinesMap.set(t.id, line);
					}
					const model = buildCard({ now: now(), tasks, lastLines: lastLinesMap, orca: bridge?.state, fleet: fleet?.state, fleetIncomplete: fleet?.incomplete, collapsed: cardMode === "collapsed", maxRows: 8 });
					return model ? [...renderCardLines(model, theme, width), ""] : [];
				},
				invalidate() {},
			};
		});
	}

	// ---- Orca worker side: preamble, lifecycle results, reminder -----------

	pi.on("input", (event) => {
		if (inOrcaTerminal && !gentleChild) worker = onInput(worker, event.text ?? "");
		return undefined;
	});

	pi.on("agent_before_settle", (event, ctx) => {
		if (!inOrcaTerminal || gentleChild || !worker.identity) return undefined;
		let busy = (manager?.running().length ?? 0) > 0;
		try {
			busy = busy || ctx.hasPendingMessages();
		} catch {
			/* ignore */
		}
		const r = reminderFor(worker, { outcome: event.outcome, now: now(), busy });
		worker = r.state;
		if (!r.text) return undefined;
		return { entries: [{ type: "custom_message" as const, customType: WORKER_MESSAGE, content: r.text, display: true }], continue: true };
	});

	// ---- bash guard and lifecycle detection --------------------------------

	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return;
		const command = String((event.input as { command?: unknown }).command ?? "");
		if (!classifyOrcaCommand(command).includes("consuming-check")) return;
		if (inOrcaTerminal && gentleChild) {
			return { block: true, reason: "This is a subagent of an Orca coordinator: it shares the coordinator's terminal identity, so a consuming `orca orchestration check` would take the coordinator's mail. Report back to the parent instead; read-only `check --peek` / `--all` are allowed." };
		}
		if (bridgeOwnsMailbox()) return { block: true, reason: BLOCK_REASON };
		return;
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash") return;
		const command = String((event.input as { command?: unknown }).command ?? "");
		const kinds = classifyOrcaCommand(command);
		if (kinds.includes("bind")) bridge?.detectSoon();
		if (kinds.includes("worker-start")) fleet?.pokeSoon();
		if (kinds.includes("worker-done") || kinds.includes("escalation")) {
			worker = onLifecycleResult(worker, kinds, command, acceptedByOrca(textOf(event.content), event.isError));
		}
		return;
	});

	// ---- renderers --------------------------------------------------------

	pi.registerMessageRenderer(TASK_MESSAGE, (message, options, theme) => {
		const body = sanitizeTerminal(textOf(message.content)).replace(/^pi-bg:\s*\n?/, "");
		const details = message.details as { tasks?: Array<{ kind?: string; exitCode?: number | null; signal?: string | null }> } | undefined;
		const failed = details?.tasks?.some((t) => t.kind === "timeout" || t.kind === "error" || (t.kind === "exit" && (t.exitCode !== 0 || t.signal)));
		const [first, ...rest] = body.split("\n");
		const shown = options.expanded ? rest : rest.slice(0, 8);
		const more = !options.expanded && rest.length > shown.length ? `\n${theme.fg("dim", `… ${rest.length - shown.length} more lines`)}` : "";
		return new Text(`${theme.fg(failed ? "error" : "success", `⏵ ${first}`)}\n${theme.fg("customMessageText", shown.join("\n"))}${more}`, options.outputPad, 0);
	});

	pi.registerMessageRenderer(ORCA_MESSAGE, (message, options, theme) => {
		const details = (message.details ?? {}) as { deliveryId?: string; runId?: string; messages?: MessageFact[]; heartbeats?: number; replay?: boolean; reminder?: boolean };
		const view = deliveryView(details, sanitizeTerminal(textOf(message.content)), options.expanded);
		const body = view.lines.map((l) => theme.fg(l.tone === "text" ? "customMessageText" : l.tone, l.text)).join("\n");
		return new Text(`${theme.fg(view.tone, `⇄ ${view.title}`)}\n${body}`, options.outputPad, 0);
	});

	pi.registerMessageRenderer(FLEET_MESSAGE, (message, options, theme) => {
		const body = sanitizeTerminal(textOf(message.content));
		const [first, ...rest] = body.split("\n");
		const shown = options.expanded ? rest : rest.filter((l) => l.startsWith("- ") || l.startsWith("    your note")).slice(0, 10);
		return new Text(`${theme.fg("warning", `⚑ ${first}`)}\n${theme.fg("customMessageText", shown.join("\n"))}`, options.outputPad, 0);
	});

	pi.registerMessageRenderer(WORKER_MESSAGE, (message, options, theme) => new Text(theme.fg("warning", `⚑ ${sanitizeTerminal(textOf(message.content))}`), options.outputPad, 0));

	// ---- background task tools -------------------------------------------

	const need = (): TaskManager => {
		if (!manager) throw new Error("pi-bg is not active in this session yet.");
		return manager;
	};

	pi.registerTool({
		name: "bg_run",
		label: "Background run",
		description:
			"Start a shell command in the background and return immediately. Use it for anything that may take more than about a minute: verification gates, test suites, builds, CI watches (`gh run watch`, `gh pr checks --watch`), deploys, log tails, production watchers. " +
			"Output goes to a log file. When the command exits you receive a 'pi-bg' message automatically (the session wakes if idle), so do not poll or sleep: keep working, or end your turn. " +
			"Optional watch: notify when an output line matches a regex, either once (`until`, stops the task unless keep_running) or for each match (`each`, coalesced, capped by max_events). " +
			"Watches default to a 30 minute deadline. Tasks, including anything they start in the background, are killed when they end, when the session exits or reloads.",
		promptSnippet: "bg_run: run long commands in the background; you are notified when they finish or match a watch pattern.",
		promptGuidelines: [
			"Use bg_run instead of a blocking bash call for commands that can take more than about a minute (verify gates, builds, `gh run watch`, deploys, log watches). After starting one, continue with other work or end the turn; its completion arrives as a 'pi-bg' message. Never loop with sleep to wait for it.",
			"Delegation layers: gentle subagents for in-session exploration or parallel work; Orca workers for work in another terminal, worktree or repository; bg_run for plain shell commands. They combine freely.",
		],
		parameters: Type.Object(
			{
				command: Type.String({ description: "Shell command line, run with bash -c." }),
				cwd: Type.Optional(Type.String({ description: "Working directory; defaults to the session cwd." })),
				label: Type.Optional(Type.String({ description: "Short human label, e.g. 'serverful verify'." })),
				timeout_s: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_TIMEOUT_S, description: "Deadline in seconds; the task is stopped and reported when reached. 0 = none. Default: none, or 1800 with watch." })),
				watch: Type.Optional(
					Type.Object(
						{
							pattern: Type.String({ description: "JavaScript regex tested against each output line." }),
							flags: Type.Optional(Type.String({ description: "Regex flags from i, m, s, u, v." })),
							mode: Type.Optional(Type.Union([Type.Literal("until"), Type.Literal("each")], { description: "until: notify on the first match (default). each: notify per match, coalesced over 2s." })),
							keep_running: Type.Optional(Type.Boolean({ description: "until-mode: keep the command running after the match (default false: stop it)." })),
							max_events: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "each-mode: maximum notices (default 20)." })),
						},
						{ additionalProperties: false },
					),
				),
			},
			{ additionalProperties: false },
		),
		renderResult: compactResult,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			ctxRef = ctx;
			if ((bridgeOwnsMailbox() || (inOrcaTerminal && gentleChild)) && classifyOrcaCommand(params.command).includes("consuming-check")) throw new Error(BLOCK_REASON);
			const timeoutS = params.timeout_s ?? (params.watch ? WATCH_DEFAULT_TIMEOUT_S : 0);
			const task = await need().start({
				command: params.command,
				cwd: params.cwd || ctx.cwd,
				label: params.label,
				timeoutMs: timeoutS > 0 ? timeoutS * 1000 : undefined,
				watch: params.watch ? { pattern: params.watch.pattern, flags: params.watch.flags, mode: params.watch.mode, keepRunning: params.watch.keep_running, maxEvents: params.watch.max_events } : undefined,
			});
			const deadline = timeoutS > 0 ? ` · deadline ${formatDuration(timeoutS * 1000)}` : "";
			return {
				content: [{ type: "text", text: `Started ${task.id}${task.label !== task.id ? ` "${clip(clean(task.label), 60)}"` : ""} (pid ${task.pid})${deadline}.\nlog: ${task.logPath}\nYou will get a pi-bg message when it ${params.watch ? "matches or " : ""}exits; keep working or end the turn.` }],
				details: { id: task.id, logPath: task.logPath },
			};
		},
	});

	pi.registerTool({
		name: "bg_status",
		label: "Background status",
		description: "List background tasks of this session (running and finished) with status, duration and log path, or one task by id.",
		parameters: Type.Object({ id: Type.Optional(Type.String()) }, { additionalProperties: false }),
		renderResult: compactResult,
		async execute(_id, params) {
			const m = need();
			const t = now();
			const tasks = params.id ? [m.get(params.id)].filter((x): x is TaskSnapshot => Boolean(x)) : m.list();
			if (params.id && tasks.length === 0) throw new Error(`Unknown task ${params.id}`);
			const text = tasks.length ? tasks.map((x) => describeTask(x, t)).join("\n") : "No background tasks in this session.";
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerTool({
		name: "bg_tail",
		label: "Background tail",
		description: "Read the last lines of a background task's log (sanitized, credentials redacted, max 400 lines). Optional case-insensitive grep regex filters lines first.",
		parameters: Type.Object(
			{
				id: Type.String(),
				lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 400 })),
				grep: Type.Optional(Type.String({ description: "Case-insensitive regex; only matching lines are returned." })),
			},
			{ additionalProperties: false },
		),
		renderResult: compactResult,
		async execute(_id, params) {
			const m = need();
			const task = m.get(params.id);
			if (!task) throw new Error(`Unknown task ${params.id}`);
			const text = await m.tail(params.id, { lines: params.lines, grep: params.grep });
			return { content: [{ type: "text", text: `${describeTask(task, now())}\n---\n${text || "(no output)"}` }], details: undefined };
		},
	});

	pi.registerTool({
		name: "bg_cancel",
		label: "Background cancel",
		description: "Stop a running background task (TERM to its process group, KILL after 3s). No completion notice is sent for a cancelled task.",
		parameters: Type.Object({ id: Type.String() }, { additionalProperties: false }),
		renderResult: compactResult,
		async execute(_id, params) {
			const ok = need().cancel(params.id);
			if (!ok) throw new Error(`Task ${params.id} is not running.`);
			return { content: [{ type: "text", text: `Cancelling ${params.id}.` }], details: undefined };
		},
	});

	// ---- Orca coordinator tools (active only while a Run is bound) --------

	if (orcaEnabled) {
		pi.registerTool({
			name: "orca_ack",
			label: "Orca ack",
			description:
				"Acknowledge the pending Orca delivery after processing every message in it (answered questions, validated worker_done, release/retain decided). " +
				"pi-bg then re-arms the Run waiter. If Orca already holds the next batch it is returned in this result and becomes the pending delivery.",
			promptSnippet: "orca_ack: acknowledge a processed Orca delivery (pi-bg owns this coordinator's Run mailbox waiter).",
			promptGuidelines: [
				"This session coordinates an Orca Run through pi-bg: it keeps the only `orca orchestration check --wait` waiter and delivers each mailbox batch as an 'Orca delivery' message. Do not run consuming `orca orchestration check` or orca-wait and do not start waiters. Process every message of a delivery as the orchestration guide requires, then call orca_ack with its deliveryId. Heartbeat-only batches are acknowledged automatically.",
				"pi-bg also watches the Run's workers model-free and sends an 'Orca fleet' message when one stalls without worker_done, waits on a prompt, exits, needs attention or awaits release. The work is not finished while workers are open: decide the next step from those notices and orca_workers.",
			],
			parameters: Type.Object({ deliveryId: Type.String({ description: "The deliveryId shown in the Orca delivery message." }) }, { additionalProperties: false }),
			executionMode: "sequential",
			renderResult: compactResult,
			async execute(_id, params, _signal, _onUpdate, ctx) {
				ctxRef = ctx;
				if (!bridge) throw new Error("The Orca bridge is not running in this session.");
				const reply = await bridge.ack(params.deliveryId);
				if (!reply.ok) throw new Error(reply.text);
				const text = reply.next ? `${reply.text}\n\n${formatDelivery(reply.next, { note: reply.note, rawPath: reply.rawPath })}` : reply.text;
				return { content: [{ type: "text", text }], details: { next: reply.next?.id } };
			},
		});

		pi.registerTool({
			name: "orca_inbox",
			label: "Orca inbox",
			description: "Show the Orca bridge state and the pending delivery again (for example after compaction). Read-only: it never consumes or acknowledges mail.",
			parameters: Type.Object({}, { additionalProperties: false }),
			renderResult: compactResult,
			async execute() {
				if (!bridge) return { content: [{ type: "text", text: "The Orca bridge is not running in this session." }], details: undefined };
				const s = bridge.state;
				const lines = [
					`bridge: ${s.phase} · run ${s.runId ?? "none"}${s.explicitRun ? " (explicit)" : ""} · ${s.reason}`,
					`deliveries shown: ${s.deliveriesInjected} · heartbeats auto-acked: ${s.heartbeatsAcked}${s.lastError ? ` · last error: ${s.lastError}` : ""}`,
				];
				if (s.pending) lines.push("", formatDelivery(s.pending));
				return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
			},
		});

		pi.registerTool({
			name: "orca_workers",
			label: "Orca workers",
			description: "Show the fleet of the bound Run (read-only): each open worker with outcome, activity and its age, liveness, attention and nextAction, plus tasks that have no worker. all=true includes settled history; refresh=true polls Orca now.",
			parameters: Type.Object({ all: Type.Optional(Type.Boolean()), refresh: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
			renderResult: compactResult,
			async execute(_id, params) {
				if (!fleet || !fleet.runId) return { content: [{ type: "text", text: "No Run is bound, so there is no fleet to show." }], details: undefined };
				if (params.refresh || fleet.lastPollAt === null) await fleet.poll();
				const header = fleet.lastError ? `(warning: ${fleet.lastError})\n` : "";
				return { content: [{ type: "text", text: header + formatWorkersTable(fleet.state, fleet.runId, now(), { all: params.all }) }], details: undefined };
			},
		});

		pi.registerTool({
			name: "orca_watch",
			label: "Orca watch",
			description:
				"Ask to be notified about one worker, with a note to yourself that comes back verbatim in the notice (e.g. 'when A0 settles, launch the A1 review'). Every worker of the Run is already watched for stalls, prompts, exits and attention; this adds events (settled, any activity change) and the note. The note survives /reload.",
			parameters: Type.Object(
				{
					dispatchId: Type.String({ description: "Dispatch id (ctx_...) of the worker." }),
					on: Type.Optional(Type.Array(Type.Union([Type.Literal("settled"), Type.Literal("stalled"), Type.Literal("blocked"), Type.Literal("any")]), { description: "Events to report (default settled, stalled, blocked)." })),
					note: Type.Optional(Type.String({ description: "What to do when it fires." })),
				},
				{ additionalProperties: false },
			),
			renderResult: compactResult,
			async execute(_id, params) {
				if (!fleet || !fleet.runId) throw new Error("No Run is bound, so there is no fleet to watch.");
				const watch = { dispatchId: params.dispatchId, on: (params.on?.length ? params.on : ["settled", "stalled", "blocked"]) as WatchOn[], note: clip(params.note ?? "", 500), createdAt: now() };
				fleet.addWatch(watch);
				pi.appendEntry(WATCH_ENTRY, watch);
				return { content: [{ type: "text", text: `Watching ${params.dispatchId} for ${watch.on.join(", ")}${watch.note ? ` with note: ${watch.note}` : ""}.` }], details: undefined };
			},
		});
	}

	// ---- commands -----------------------------------------------------------

	pi.registerCommand("bg", {
		description: "pi-bg: `/bg` lists tasks · `/bg kill <id|all>` · `/bg card on|off|collapse`.",
		handler: async (args, ctx) => {
			const m = manager;
			if (!m) return;
			const [verb, target] = args.trim().split(/\s+/);
			if (verb === "kill" && target) {
				const ids = target === "all" ? m.running().map((t) => t.id) : [target];
				const killed = ids.filter((id) => m.cancel(id));
				ctx.ui.notify(killed.length ? `Cancelling ${killed.join(", ")}` : `Nothing to cancel for ${target}`, "info");
				return;
			}
			if (verb === "card") {
				cardMode = target === "off" ? "off" : target === "collapse" ? "collapsed" : "on";
				installCard(ctx);
				refresh();
				ctx.ui.notify(`pi-bg card ${cardMode}`, "info");
				return;
			}
			const tasks = m.list();
			ctx.ui.notify(tasks.length ? tasks.map((t) => describeTask(t, now())).join("\n") : "No background tasks.", "info");
		},
	});

	if (orcaEnabled) {
		pi.registerCommand("orca-watch", {
			description: "Orca bridge: `/orca-watch` (status and fleet), `on`, `off`, or `<run_id>` to consume that Run explicitly.",
			handler: async (args, ctx) => {
				const b = bridge;
				if (!b) {
					ctx.ui.notify("The Orca bridge only runs in an interactive Pi session inside an Orca terminal.", "warning");
					return;
				}
				const arg = args.trim();
				if (arg === "off") b.turnOff();
				else if (arg === "on") b.turnOn();
				else if (arg && arg !== "status") b.watchRun(arg);
				const s = b.state;
				const fleetLine = fleet?.runId ? `\n${formatWorkersTable(fleet.state, fleet.runId, now()).split("\n").slice(0, 8).join("\n")}` : "";
				ctx.ui.notify(`orca bridge: ${s.phase} · run ${s.runId ?? "none"} · ${s.reason}${s.pending ? ` · pending ${s.pending.id}` : ""} · heartbeats acked ${s.heartbeatsAcked}${s.lastError ? `\nlast error: ${s.lastError}` : ""}${fleetLine}`, "info");
			},
		});
	}

}

async function pruneOldLogs(logRoot: string): Promise<void> {
	const { readdir } = await import("node:fs/promises");
	try {
		for (const dir of await readdir(logRoot)) await pruneOld(join(logRoot, dir), 7 * 24 * 3600_000);
	} catch {
		/* first run */
	}
}
