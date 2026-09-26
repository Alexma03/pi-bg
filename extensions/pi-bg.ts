// pi-bg: background tasks that wake the model when they finish, and a
// first-class bridge to the Orca orchestration mailbox for coordinator
// sessions. See README.md for the contract and docs/manual-test-plan.md.
//
// Wake delivery uses custom messages with `deliverAs: "steer"` and
// `triggerTurn: true`: an idle session starts a turn at once; a busy one
// sees the message before its next model call. `followUp` is avoided on
// purpose (it waits for the whole run to stop).

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { OrcaBridge, pruneOld } from "../lib/orca/bridge.ts";
import { formatDelivery, typeSummary, type Delivery } from "../lib/orca/delivery.ts";
import { BLOCK_REASON, classifyOrcaCommand } from "../lib/orca/guard.ts";
import { footerText } from "../lib/status.ts";
import { TaskManager, type TaskSnapshot } from "../lib/tasks/manager.ts";
import { formatNotices, type TaskNotice } from "../lib/tasks/notice.ts";
import { formatDuration, sanitizeTerminal } from "../lib/text.ts";

const TASK_MESSAGE = "pi-bg-task";
const ORCA_MESSAGE = "pi-bg-orca";
const STATUS_KEY = "pi-bg";
const NOTICE_BATCH_MS = 400;
const WATCH_DEFAULT_TIMEOUT_S = 30 * 60;
const MAX_TIMEOUT_S = 24 * 3600;

function stateDir(env: NodeJS.ProcessEnv): string {
	if (env.PI_BG_STATE_DIR) return env.PI_BG_STATE_DIR;
	return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi-bg");
}

function orcaEligible(env: NodeJS.ProcessEnv): boolean {
	return Boolean(env.ORCA_TERMINAL_HANDLE) && env.GENTLE_PI_AGENTS_CHILD !== "1" && env.PI_BG_ORCA !== "0";
}

function describeTask(t: TaskSnapshot, now: number): string {
	const age = formatDuration((t.endedAt ?? now) - t.startedAt);
	const exit = t.status === "running" ? "" : t.signal ? ` (${t.signal})` : t.exitCode !== null ? ` (exit ${t.exitCode})` : "";
	const watch = t.watch ? ` · watch /${t.watch.pattern}/ ${t.watch.mode ?? "until"}${t.watchEvents ? ` ${t.watchEvents} hit${t.watchEvents === 1 ? "" : "s"}` : ""}` : "";
	return `${t.id} ${t.status}${exit} ${age} · ${t.label !== t.id ? `"${t.label}" · ` : ""}${t.command.slice(0, 120)}${watch}\n   log: ${t.logPath}`;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text?: unknown }).text ?? "") : "")).join("\n");
	return "";
}

export default function piBg(pi: ExtensionAPI) {
	if (process.env.PI_BG_DISABLE === "1") return;

	const env = process.env;
	const root = stateDir(env);
	const orcaEnabled = orcaEligible(env);

	let ctxRef: ExtensionContext | undefined;
	let manager: TaskManager | undefined;
	let bridge: OrcaBridge | undefined;
	let noticeQueue: TaskNotice[] = [];
	let noticeTimer: ReturnType<typeof setTimeout> | undefined;
	let exitHook: (() => void) | undefined;
	let active = false;

	const refreshStatus = () => {
		const ctx = ctxRef;
		if (!ctx?.hasUI) return;
		try {
			ctx.ui.setStatus(STATUS_KEY, footerText(manager?.running().length ?? 0, bridge?.state, Date.now()));
		} catch {
			/* UI may be gone during shutdown */
		}
	};

	const flushNotices = () => {
		noticeTimer = undefined;
		if (!active || noticeQueue.length === 0) return;
		const batch = noticeQueue;
		noticeQueue = [];
		pi.sendMessage(
			{
				customType: TASK_MESSAGE,
				content: formatNotices(batch),
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
				details: { deliveryId: delivery.id, runId: delivery.runId, types: typeSummary(delivery), replay: Boolean(note) },
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

	// ---- lifecycle -------------------------------------------------------

	pi.on("session_start", (_event, ctx) => {
		ctxRef = ctx;
		if (active) return;
		active = true;
		const sessionId = ctx.sessionManager.getSessionId?.() || "session";
		manager = new TaskManager({
			logDir: join(root, "logs", sessionId.replace(/[^A-Za-z0-9_-]/g, "_")),
			now: Date.now,
			onNotice: queueNotice,
			onChange: refreshStatus,
		});
		void pruneOldLogs(join(root, "logs"));
		if (orcaEnabled && ctx.mode === "tui") {
			bridge = new OrcaBridge({
				orcaBin: env.PI_BG_ORCA_BIN || "orca",
				cwd: ctx.cwd,
				env,
				rawDir: join(root, "orca"),
				now: Date.now,
				inject: injectDelivery,
				remind: remindDelivery,
				onChange: refreshStatus,
			});
			bridge.start();
		}
		const onExit = () => {
			manager?.killAllSync();
			bridge?.killSync();
		};
		exitHook = onExit;
		process.once("exit", onExit);
		refreshStatus();
	});

	pi.on("session_shutdown", async () => {
		if (!active) return;
		active = false;
		if (noticeTimer) clearTimeout(noticeTimer);
		noticeTimer = undefined;
		noticeQueue = [];
		bridge?.dispose();
		await manager?.shutdown();
		if (exitHook) process.removeListener("exit", exitHook);
		exitHook = undefined;
		try {
			ctxRef?.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			/* ignore */
		}
		bridge = undefined;
		manager = undefined;
	});

	// ---- bash guard and Run-binding detection ----------------------------

	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash" || !bridge) return;
		const phase = bridge.state.phase;
		if (phase === "off" || phase === "fenced") return;
		const command = String((event.input as { command?: unknown }).command ?? "");
		if (classifyOrcaCommand(command).includes("consuming-check")) return { block: true, reason: BLOCK_REASON };
		return;
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash" || !bridge) return;
		const command = String((event.input as { command?: unknown }).command ?? "");
		if (classifyOrcaCommand(command).includes("bind")) bridge.detectSoon();
		return;
	});

	// ---- renderers --------------------------------------------------------

	pi.registerMessageRenderer(TASK_MESSAGE, (message, options, theme) => {
		const body = sanitizeTerminal(textOf(message.content)).replace(/^pi-bg:\s*\n?/, "");
		const [first, ...rest] = body.split("\n");
		const shown = options.expanded ? rest : rest.slice(0, 8);
		const more = !options.expanded && rest.length > shown.length ? `\n${theme.fg("dim", `… ${rest.length - shown.length} more lines`)}` : "";
		return new Text(`${theme.fg("customMessageLabel", `⏵ background · ${first}`)}\n${theme.fg("customMessageText", shown.join("\n"))}${more}`, options.outputPad, 0);
	});

	pi.registerMessageRenderer(ORCA_MESSAGE, (message, options, theme) => {
		const body = sanitizeTerminal(textOf(message.content));
		const [first, ...rest] = body.split("\n");
		const shown = options.expanded ? rest : rest.slice(0, 14);
		const more = !options.expanded && rest.length > shown.length ? `\n${theme.fg("dim", `… ${rest.length - shown.length} more lines`)}` : "";
		return new Text(`${theme.fg("customMessageLabel", `⇄ ${first}`)}\n${theme.fg("customMessageText", shown.join("\n"))}${more}`, options.outputPad, 0);
	});

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
			"Watches default to a 30 minute deadline. Tasks are killed when the session exits or reloads.",
		promptSnippet: "bg_run: run long commands in the background; you are notified when they finish or match a watch pattern.",
		promptGuidelines: [
			"Use bg_run instead of a blocking bash call for commands that can take more than about a minute (verify gates, builds, `gh run watch`, deploys, log watches). After starting one, continue with other work or end the turn; its completion arrives as a 'pi-bg' message. Never loop with sleep to wait for it.",
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
		async execute(_id, params, _signal, _onUpdate, ctx) {
			ctxRef = ctx;
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
				content: [{ type: "text", text: `Started ${task.id}${task.label !== task.id ? ` "${task.label}"` : ""} (pid ${task.pid})${deadline}.\nlog: ${task.logPath}\nYou will get a pi-bg message when it ${params.watch ? "matches or " : ""}exits; keep working or end the turn.` }],
				details: { id: task.id, logPath: task.logPath },
			};
		},
	});

	pi.registerTool({
		name: "bg_status",
		label: "Background status",
		description: "List background tasks of this session (running and finished) with status, duration and log path, or one task by id.",
		parameters: Type.Object({ id: Type.Optional(Type.String()) }, { additionalProperties: false }),
		async execute(_id, params) {
			const m = need();
			const now = Date.now();
			const tasks = params.id ? [m.get(params.id)].filter((t): t is TaskSnapshot => Boolean(t)) : m.list();
			if (params.id && tasks.length === 0) throw new Error(`Unknown task ${params.id}`);
			const text = tasks.length ? tasks.map((t) => describeTask(t, now)).join("\n") : "No background tasks in this session.";
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
		async execute(_id, params) {
			const m = need();
			const task = m.get(params.id);
			if (!task) throw new Error(`Unknown task ${params.id}`);
			const text = await m.tail(params.id, { lines: params.lines, grep: params.grep });
			return { content: [{ type: "text", text: `${describeTask(task, Date.now())}\n---\n${text || "(no output)"}` }], details: undefined };
		},
	});

	pi.registerTool({
		name: "bg_cancel",
		label: "Background cancel",
		description: "Stop a running background task (TERM to its process group, KILL after 3s). No completion notice is sent for a cancelled task.",
		parameters: Type.Object({ id: Type.String() }, { additionalProperties: false }),
		async execute(_id, params) {
			const ok = need().cancel(params.id);
			if (!ok) throw new Error(`Task ${params.id} is not running.`);
			return { content: [{ type: "text", text: `Cancelling ${params.id}.` }], details: undefined };
		},
	});

	// ---- Orca tools (only inside Orca terminals) -------------------------

	if (orcaEnabled) {
		pi.registerTool({
			name: "orca_ack",
			label: "Orca ack",
			description:
				"Acknowledge the pending Orca delivery after processing every message in it (answered questions, validated worker_done, release/retain decided). " +
				"pi-bg then re-arms the Run waiter. If Orca already holds the next batch it is returned in this result and becomes the pending delivery.",
			promptSnippet: "orca_ack: acknowledge a processed Orca delivery (pi-bg owns the Run mailbox waiter).",
			promptGuidelines: [
				"When this session coordinates an Orca Run, pi-bg keeps the only `orca orchestration check --wait` waiter and delivers each mailbox batch as an 'Orca delivery' message. Do not run consuming `orca orchestration check` or orca-wait yourself and do not start waiters. Process every message of a delivery as the orchestration guide requires, then call orca_ack with its deliveryId. Heartbeat-only batches are acknowledged automatically.",
			],
			parameters: Type.Object({ deliveryId: Type.String({ description: "The deliveryId shown in the Orca delivery message." }) }, { additionalProperties: false }),
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
			async execute() {
				if (!bridge) return { content: [{ type: "text", text: "The Orca bridge is not running in this session (not an Orca TUI session, or disabled)." }], details: undefined };
				const s = bridge.state;
				const lines = [
					`bridge: ${s.phase} · run ${s.runId ?? "none"}${s.explicitRun ? " (explicit)" : ""} · ${s.reason}`,
					`deliveries shown: ${s.deliveriesInjected} · heartbeats auto-acked: ${s.heartbeatsAcked}${s.lastError ? ` · last error: ${s.lastError}` : ""}`,
				];
				if (s.pending) lines.push("", formatDelivery(s.pending));
				return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
			},
		});
	}

	// ---- commands -----------------------------------------------------------

	pi.registerCommand("bg", {
		description: "List pi-bg background tasks; `/bg kill <id|all>` stops them.",
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
			const tasks = m.list();
			ctx.ui.notify(tasks.length ? tasks.map((t) => describeTask(t, Date.now())).join("\n") : "No background tasks.", "info");
		},
	});

	if (orcaEnabled) {
		pi.registerCommand("orca-watch", {
			description: "Orca mailbox bridge: `/orca-watch` (status), `on`, `off`, or `<run_id>` to consume that Run explicitly.",
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
				ctx.ui.notify(`orca bridge: ${s.phase} · run ${s.runId ?? "none"} · ${s.reason}${s.pending ? ` · pending ${s.pending.id}` : ""} · heartbeats acked ${s.heartbeatsAcked}${s.lastError ? `\nlast error: ${s.lastError}` : ""}`, "info");
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
