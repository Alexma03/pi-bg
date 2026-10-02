// pi-bg: background tasks that wake the model when they finish, a first-class
// bridge to the Orca orchestration mailbox for coordinator sessions, a
// model-free fleet watch of the Run's workers, and a worker-side reminder.
// See README.md and docs/manual-test-plan.md.
//
// Wake delivery: a busy session gets a custom message with `deliverAs:
// "steer"`, seen before its next model call (`followUp` would wait for the
// whole run to stop). An idle session gets the message for its next turn and
// a short prompt that starts it: Pi skips before_agent_start for a turn
// started by `triggerTurn`, so extensions that build the system prompt there
// (Gentle Shell) would be missing from it, and claude-bridge refuses the turn.

import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { OrcaBridge, pruneOld } from "../lib/orca/bridge.ts";
import { formatDelivery, heartbeatCount, typeSummary, type Delivery } from "../lib/orca/delivery.ts";
import { FleetWatch } from "../lib/orca/fleet-driver.ts";
import { profileModel, type ModelParts, type PiProfileSettings } from "../lib/orca/model.ts";
import { releaseOne, releaseSelection } from "../lib/orca/release.ts";
import { trimWorkerScreen } from "../lib/orca/screen.ts";
import type { WatchdogConfig } from "../lib/orca/watchdog.ts";
import { dedupeFleetEvents, formatFleetNotice, formatWorkersTable, mustWake, shouldWake } from "../lib/orca/fleet-format.ts";
import { isInProgress, type FleetEvent, type FleetState, type WatchOn } from "../lib/orca/fleet.ts";
import { BLOCK_REASON, classifyOrcaCommand } from "../lib/orca/guard.ts";
import { extractJson } from "../lib/orca/cli.ts";
import { runOrcaCli } from "../lib/orca/exec.ts";
import { attachable, attachCommand, decideMail, formatMailNotice, initialMail, parsePeek, type MailState } from "../lib/orca/worker-mail.ts";
import { acceptedByOrca, initialWorker, onInput, onLifecycleResult, reminderFor, type WorkerState } from "../lib/orca/worker.ts";
import { redact } from "../lib/redact.ts";
import { stateBlock } from "../lib/state-block.ts";
import { bgStatus, orcaStatus } from "../lib/status.ts";
import { TaskManager, type TaskSnapshot } from "../lib/tasks/manager.ts";
import { formatNotices, type TaskNotice } from "../lib/tasks/notice.ts";
import { clip, formatDuration, sanitizeTerminal } from "../lib/text.ts";
import { buildBgCard, buildOrcaCard, foldCard, renderCardLines, type CardModel } from "../lib/ui/card.ts";
import { deliveryView, messageFacts, type MessageFact } from "../lib/ui/delivery-view.ts";
import { createWakeBudget, nextWakeAt, takeWake } from "../lib/wake-budget.ts";
import { delegationGuide } from "../lib/delegation.ts";

const TASK_MESSAGE = "pi-bg-task";
const ORCA_MESSAGE = "pi-bg-orca";
const FLEET_MESSAGE = "pi-bg-fleet";
const WORKER_MESSAGE = "pi-bg-worker";
const MAIL_MESSAGE = "pi-bg-worker-mail";
const MAIL_POLL_MS = 15_000;
const ATTACH_CLIENT = fileURLToPath(new URL("../lib/tasks/attach-client.mjs", import.meta.url));
const WATCH_ENTRY = "pi-bg-watch";
const FLEET_SEEN_ENTRY = "pi-bg-fleet-seen";
const RELEASE_RESOLVED_ENTRY = "pi-bg-release-resolved";
const STATUS_KEY = "pi-bg";
const ORCA_STATUS_KEY = "pi-bg-orca";
const CARD_KEY = "pi-bg-card";
const ORCA_CARD_KEY = "pi-bg-orca-card";
const NOTICE_BATCH_MS = 400;
const FLEET_BATCH_MS = 5_000;
const MAX_TIMEOUT_S = 24 * 3600;
/** A bash call without its own timeout is expected to be short. */
const DETACHED_DEFAULT_TIMEOUT_S = 30 * 60;
/** A bash command still running after this moves to the background by itself. */
const AUTO_BACKGROUND_S = 10;
const ORCA_TOOLS = ["orca_ack", "orca_workers", "orca_watch", "orca_release", "orca_screen", "orca_config"];
/** The prompt pi-bg sends to wake an idle session; not new direction from the user. */
const WAKE_PREFIX = "⟳ pi-bg: ";

function stateDir(env: NodeJS.ProcessEnv): string {
	if (env.PI_BG_STATE_DIR) return env.PI_BG_STATE_DIR;
	return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi-bg");
}

/** The model a Pi worker starts with when no `--model` is given: project settings, then personal. */
function piDefaultModel(cwd: string): ModelParts | undefined {
	for (const file of [join(cwd, ".pi", "settings.json"), join(homedir(), ".pi", "agent", "settings.json")]) {
		try {
			const settings = JSON.parse(readFileSync(file, "utf8")) as PiProfileSettings;
			const model = profileModel(settings);
			if (model) return model;
		} catch {
			/* missing or unreadable */
		}
	}
	return undefined;
}

const clean = (text: string): string => redact(sanitizeTerminal(text));

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

function describeTask(t: TaskSnapshot, now: number): string {
	const age = formatDuration((t.endedAt ?? now) - t.startedAt);
	const exit = t.status === "running" ? "" : t.signal ? ` (${t.signal})` : t.exitCode !== null ? ` (exit ${t.exitCode})` : "";
	const watch = t.watch ? ` · watch /${clean(t.watch.pattern)}/ ${t.watch.mode ?? "until"}${t.watchEvents ? ` ${t.watchEvents} hit${t.watchEvents === 1 ? "" : "s"}` : ""}` : "";
	const label = t.label !== t.id ? `"${clip(clean(t.label), 60)}" · ` : "";
	const logError = t.logError ? ` · log error: ${t.logError}` : "";
	const deadline = t.timeoutMs ? `deadline ${formatDuration(t.timeoutMs)} · ` : "";
	return `${t.id} ${t.status}${exit} ${age} · ${deadline}${label}${clip(clean(t.command), 120)}${watch}${logError}\n   log: ${t.logPath}`;
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
	/** Wake-worthy fleet notices waiting for the wake budget to free a slot. */
	let heldFleet: FleetEvent[] = [];
	let heldTimer: ReturnType<typeof setTimeout> | undefined;
	/** Worker conditions already reported (dispatchId|group -> time), see dedupeFleetEvents. */
	const fleetReported = new Map<string, number>();
	let fleetTimer: ReturnType<typeof setTimeout> | undefined;
	let wakeBudget = createWakeBudget();
	let exitHook: (() => void) | undefined;
	let tickTimer: ReturnType<typeof setInterval> | undefined;
	let cardTui: TUI | undefined;
	let cardMode: "on" | "collapsed" | "off" = env.PI_BG_CARD === "off" ? "off" : "on";
	/** Widget keys of the cards folded to one line (by a click or /bg card fold). */
	const foldedCards = new Set<string>();
	/** Interactive session in an Orca terminal: the bridge and its tools run here. Set at session_start. */
	let orcaInteractive = true;
	/** Consecutive failed worker mail peeks, shown in the status line. */
	let mailFailures = 0;
	let mail: MailState = initialMail();
	let mailTimer: ReturnType<typeof setInterval> | undefined;
	let mailPolling = false;
	/** bash tool calls whose command runs as an attached pi-bg task. */
	const attachedCalls = new Map<string, string>();
	/** Per attached bash call: the timer that moves it to the background. */
	const autoTimers = new Map<string, ReturnType<typeof setTimeout>>();
	let active = false;

	const now = () => Date.now();
	const bridgeOwnsMailbox = (): boolean => Boolean(bridge && bridge.state.phase !== "off" && bridge.state.phase !== "fenced");

	const liveState = () => stateBlock({ now: now(), tasks: manager?.list() ?? [], orca: bridge?.state, fleet: fleet?.state, fleetIncomplete: fleet?.incomplete });

	/**
	 * Orca coordinator tools are active in an Orca terminal from the start, so a
	 * run-create in the middle of a turn can be acknowledged in that same turn:
	 * some providers (claude-bridge) freeze the tool list for the whole turn.
	 * A dispatched worker loses them unless it binds a Run itself; it keeps
	 * its preamble's `check`.
	 */
	const syncOrcaTools = () => {
		if (!orcaEnabled) return;
		// Only an interactive session runs the bridge, so only it gets the tools.
		const want = orcaInteractive && (!worker.identity || bridgeOwnsMailbox() || bridge?.state.phase === "fenced");
		try {
			// Compare with the live list: another extension may have replaced it.
			const all = pi.getActiveTools();
			if (want ? ORCA_TOOLS.every((name) => all.includes(name)) : !ORCA_TOOLS.some((name) => all.includes(name))) return;
			const current = all.filter((name) => !ORCA_TOOLS.includes(name));
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
			ctx.ui.setStatus(STATUS_KEY, bgStatus(manager?.running().filter((t) => !t.attached).length ?? 0));
			ctx.ui.setStatus(ORCA_STATUS_KEY, mailFailures > 0 ? `orca ⚠ correo ilegible (${mailFailures} fallos)` : bridge ? orcaStatus(bridge.state, now()) : undefined);
		} catch {
			/* UI may be gone during shutdown */
		}
		cardTui?.requestRender();
	};

	// ---- wake messages ----------------------------------------------------

	/** Deliver a message that must reach the model now (see the header comment). */
	const wake = (message: Parameters<typeof pi.sendMessage>[0], why: string) => {
		if (ctxRef?.isIdle?.()) {
			pi.sendMessage(message, { deliverAs: "nextTurn" });
			// "steer" only matters if the session got busy in between: then it is queued.
			void Promise.resolve()
				.then(() => pi.sendUserMessage(`${WAKE_PREFIX}${why}`, { deliverAs: "steer" }))
				.catch((error: unknown) => {
					// Refused prompt: the queued copy would wait for the user's next message.
					// Deliver it now the old way; the model may see it again then, which is harmless.
					if (!active) return;
					pi.sendMessage(message, { deliverAs: "steer", triggerTurn: true });
					try {
						ctxRef?.ui.notify(`pi-bg: could not start a turn for "${why}" (${clip(error instanceof Error ? error.message : String(error), 120)}); delivered it directly instead.`, "warning");
					} catch {
						/* no UI */
					}
				});
			return;
		}
		pi.sendMessage(message, { deliverAs: "steer", triggerTurn: true });
	};

	const flushNotices = () => {
		noticeTimer = undefined;
		if (!active || noticeQueue.length === 0) return;
		const batch = noticeQueue;
		noticeQueue = [];
		const state = liveState();
		wake(
			{
				customType: TASK_MESSAGE,
				content: formatNotices(batch) + (state ? `\n\n${state}` : ""),
				display: true,
				details: { tasks: batch.map((n) => ({ id: n.id, kind: n.kind, exitCode: n.exitCode, signal: n.signal, stillRunning: n.stillRunning })) },
			},
			batch.length === 1 ? "1 background task update" : `${batch.length} background task updates`,
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
		wake(
			{
				customType: ORCA_MESSAGE,
				content: formatDelivery(delivery, { note, rawPath }),
				display: true,
				details: { deliveryId: delivery.id, runId: delivery.runId, types: typeSummary(delivery), replay: Boolean(note), heartbeats: heartbeatCount(delivery), messages: messageFacts(delivery) },
			},
			`Orca delivery ${delivery.id}`,
		);
	};

	const remindDelivery = (delivery: Delivery) => {
		if (!active) return;
		wake(
			{
				customType: ORCA_MESSAGE,
				content: `Orca delivery ${delivery.id} has been pending for over 10 minutes. The Run mailbox is paused until it is acknowledged: finish processing it and call orca_ack with deliveryId "${delivery.id}", or tell the user what blocks it. orca_workers {inbox: true} shows it again.`,
				display: true,
				details: { deliveryId: delivery.id, runId: delivery.runId, reminder: true },
			},
			`Orca delivery ${delivery.id} still pending`,
		);
	};

	/** Bridge state and the pending delivery, for orca_workers {inbox: true}. */
	const inboxText = (): string => {
		if (!bridge) return "The Orca bridge is not running in this session.";
		const s = bridge.state;
		const lines = [
			`bridge: ${s.phase} · run ${s.runId ?? "none"}${s.explicitRun ? " (explicit)" : ""} · ${s.reason}`,
			`deliveries shown: ${s.deliveriesInjected} · heartbeats auto-acked: ${s.heartbeatsAcked}${s.lastError ? ` · last error: ${s.lastError}` : ""}`,
		];
		if (s.pending) lines.push("", formatDelivery(s.pending));
		return lines.join("\n");
	};

	const flushFleet = () => {
		fleetTimer = undefined;
		if (heldTimer) clearTimeout(heldTimer);
		heldTimer = undefined;
		if (!active || !fleet || fleetQueue.length + heldFleet.length === 0) return;
		const runId = fleet.runId ?? "?";
		const open = [...fleet.state.workers.values()].filter((t) => isInProgress(t.row)).map((t) => t.row.dispatchId);
		// Held notices first; then one notice per worker condition.
		const events = [...heldFleet, ...dedupeFleetEvents(fleetQueue, fleetReported, now(), open)];
		fleetQueue = [];
		heldFleet = [];
		if (events.length === 0) return;
		const wantsWake = shouldWake(events);
		let trigger = false;
		if (wantsWake) {
			if (mustWake(events)) trigger = true;
			else {
				const taken = takeWake(wakeBudget, now());
				wakeBudget = taken.budget;
				trigger = taken.allowed;
			}
		}
		if (wantsWake && !trigger) {
			// Budget spent: hold them and wake once a slot frees, instead of
			// parking them until the user happens to type.
			heldFleet = events;
			heldTimer = setTimeout(flushFleet, Math.max(1_000, nextWakeAt(wakeBudget, now()) - now()));
			heldTimer.unref?.();
			return;
		}
		// Remember what was reported so a /reload does not report it again.
		const seen = events.filter((e) => e.key).map((e) => ({ ...(e.dispatchId ? { dispatchId: e.dispatchId } : {}), key: e.key as string }));
		if (seen.length) pi.appendEntry(FLEET_SEEN_ENTRY, { runId, seen });
		// A notice that waits for the next turn would carry a stale snapshot.
		const state = trigger ? liveState() : "";
		const message = {
			customType: FLEET_MESSAGE,
			content: formatFleetNotice(events, fleet.state, runId, now()) + (state ? `\n\n${state}` : ""),
			display: true,
			details: { runId, events: events.map((e) => ({ kind: e.kind, dispatchId: e.dispatchId, title: e.title })) },
		};
		if (trigger) wake(message, `Orca fleet notice (${events.length} event${events.length === 1 ? "" : "s"})`);
		else pi.sendMessage(message, { deliverAs: "nextTurn" });
	};

	const queueFleet = (events: FleetEvent[], _state: FleetState, _runId: string) => {
		if (!active) return;
		fleetQueue.push(...events);
		if (!fleetTimer) {
			fleetTimer = setTimeout(flushFleet, FLEET_BATCH_MS);
			fleetTimer.unref?.();
		}
	};

	// ---- Orca worker side: coordinator mail ---------------------------------

	/** A dispatched worker still owes its Task: follow-ups matter and blocking commands can be detached. */
	const workerActive = (): boolean => orcaEnabled && Boolean(worker.identity) && !worker.doneSent && env.PI_BG_WORKER_MAIL !== "0";

	/** Move every attached command to the background so the model can read new mail. */
	const detachAll = (): Array<{ id: string; command: string }> => {
		const moved: Array<{ id: string; command: string }> = [];
		for (const id of attachedCalls.values()) {
			const snap = manager?.detach(id, "mail", undefined, DETACHED_DEFAULT_TIMEOUT_S * 1000);
			if (snap) moved.push({ id: snap.id, command: snap.command });
		}
		return moved;
	};

	const pollMail = async () => {
		if (!active || mailPolling || !workerActive() || !worker.identity) return;
		mailPolling = true;
		try {
			const identity = worker.identity;
			const handle = identity.workerHandle || env.ORCA_TERMINAL_HANDLE || "";
			if (!handle) return;
			const capture = await runOrcaCli(env.PI_BG_ORCA_BIN || "orca", ["orchestration", "check", "--terminal", handle, "--peek", "--json"], { cwd: ctxRef?.cwd ?? process.cwd(), env });
			const doc = extractJson(capture.stdout) as { ok?: unknown; result?: unknown } | undefined;
			if (!active || worker.identity?.dispatchId !== identity.dispatchId) return;
			// A failing peek must not hide coordinator mail silently; the model is not woken for it.
			const failed = !doc || doc.ok !== true;
			if (failed !== mailFailures > 0 || failed) {
				mailFailures = failed ? mailFailures + 1 : 0;
				refresh();
			}
			if (failed) return;
			const decision = decideMail(mail, parsePeek(doc.result, handle), now());
			mail = decision.state;
			if (!decision.announce.length) return;
			const detached = detachAll();
			wake(
				{
					customType: MAIL_MESSAGE,
					content: formatMailNotice(decision.announce, identity, { reminder: decision.reminder, detached }),
					display: true,
					details: { dispatchId: identity.dispatchId, messages: decision.announce.map((m) => ({ id: m.id, type: m.type, subject: m.subject })), detached: detached.map((d) => d.id) },
				},
				"new message from your Orca coordinator",
			);
		} finally {
			mailPolling = false;
		}
	};

	// ---- lifecycle -------------------------------------------------------

	// Delegation guide for Orca sessions (see lib/delegation.ts).
	pi.on("before_agent_start", (event) => {
		const guide = delegationGuide({ orca: orcaEnabled && orcaInteractive, worker: Boolean(worker.identity) });
		if (!guide) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${guide}` };
	});

	pi.on("session_start", (_event, ctx) => {
		ctxRef = ctx;
		if (active) return;
		active = true;
		worker = initialWorker();
		wakeBudget = createWakeBudget();
		orcaInteractive = ctx.mode === "tui";
		mailFailures = 0;
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
			fleet = new FleetWatch({ orcaBin: env.PI_BG_ORCA_BIN || "orca", cwd: ctx.cwd, env, now, watchdogPath: join(root, "orca", "watchdog.json"), onEvents: queueFleet, onChange: refresh });
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
		if (orcaEnabled) {
			mail = initialMail();
			mailTimer = setInterval(() => void pollMail(), MAIL_POLL_MS);
			mailTimer.unref?.();
		}
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
		for (const timer of [noticeTimer, fleetTimer, ...autoTimers.values()]) if (timer) clearTimeout(timer);
		autoTimers.clear();
		if (tickTimer) clearInterval(tickTimer);
		if (mailTimer) clearInterval(mailTimer);
		noticeTimer = fleetTimer = tickTimer = mailTimer = undefined;
		attachedCalls.clear();
		noticeQueue = [];
		fleetQueue = [];
		heldFleet = [];
		if (heldTimer) clearTimeout(heldTimer);
		heldTimer = undefined;
		fleetReported.clear();
		fleet?.dispose();
		bridge?.dispose();
		await manager?.shutdown();
		if (exitHook) process.removeListener("exit", exitHook);
		exitHook = undefined;
		try {
			ctxRef?.ui.setStatus(STATUS_KEY, undefined);
			ctxRef?.ui.setStatus(ORCA_STATUS_KEY, undefined);
			ctxRef?.ui.setWidget(CARD_KEY, undefined);
			ctxRef?.ui.setWidget(ORCA_CARD_KEY, undefined);
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
			const released = (ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown }>)
				.filter((entry) => entry.type === "custom" && entry.customType === RELEASE_RESOLVED_ENTRY)
				.map((entry) => entry.data as { dispatchId?: unknown } | undefined)
				.map((data) => data?.dispatchId)
				.filter((id): id is string => typeof id === "string");
			fleet?.seedReleased(released);
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
			ctx.ui.setWidget(ORCA_CARD_KEY, undefined);
			return;
		}
		const widget = (key: string, build: () => CardModel | undefined) =>
			ctx.ui.setWidget(key, (tui, theme) => {
				cardTui = tui;
				let height = 0;
				return {
					render(width: number) {
						const model = build();
						const lines = model ? [...renderCardLines(foldedCards.has(key) ? foldCard(model) : model, theme, width), ""] : [];
						height = lines.length;
						return lines;
					},
					// A left click on the card (not its spacer line) folds or unfolds it.
					// Fullscreen synthesizes the click only for the component that claimed the press.
					handleMouse(event: TuiMouseEvent) {
						if (event.button !== "left" || height === 0 || event.y < 0 || event.y >= height - 1) return undefined;
						if (event.type === "press") return { handled: true, render: false };
						if (event.type !== "click") return undefined;
						if (foldedCards.has(key)) foldedCards.delete(key);
						else foldedCards.add(key);
						return { handled: true, render: true };
					},
					invalidate() {},
				};
			});
		widget(CARD_KEY, () => {
			const m = manager;
			if (!m) return undefined;
			const tasks = m.list();
			const lastLinesMap = new Map<string, string>();
			for (const t of tasks) {
				const line = t.status === "running" ? m.lastLine(t.id) : undefined;
				if (line) lastLinesMap.set(t.id, line);
			}
			return buildBgCard({ now: now(), tasks, lastLines: lastLinesMap, collapsed: cardMode === "collapsed", maxRows: 8 });
		});
		const piModel = piDefaultModel(ctx.cwd);
		widget(ORCA_CARD_KEY, () =>
			buildOrcaCard({
				now: now(),
				orca: bridge?.state,
				fleet: fleet?.state,
				fleetIncomplete: fleet?.incomplete,
				label: fleet?.label || undefined,
				details: fleet?.details,
				activity: fleet?.activity,
				defaultModel: (agent) => (agent === "pi" ? piModel : undefined),
				collapsed: cardMode === "collapsed",
			}),
		);
	}

	// ---- Orca worker side: preamble, lifecycle results, reminder -----------

	pi.on("input", (event) => {
		// pi-bg's own wake prompt is not new direction for the worker.
		if (event.source === "extension" && event.text?.startsWith(WAKE_PREFIX)) return undefined;
		if (inOrcaTerminal && !gentleChild) {
			const before = worker.identity?.dispatchId;
			worker = onInput(worker, event.text ?? "");
			if (worker.identity && worker.identity.dispatchId !== before) {
				syncOrcaTools();
				mail = initialMail();
				setTimeout(() => void pollMail(), 2_000).unref?.();
			}
		}
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

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		const input = event.input as { command?: unknown; timeout?: unknown };
		const command = String(input.command ?? "");
		if (classifyOrcaCommand(command).includes("consuming-check")) {
			if (inOrcaTerminal && gentleChild) {
				return { block: true, reason: "This is a subagent of an Orca coordinator: it shares the coordinator's terminal identity, so a consuming `orca orchestration check` would take the coordinator's mail. Report back to the parent instead; read-only `check --peek` / `--all` are allowed." };
			}
			if (bridgeOwnsMailbox()) return { block: true, reason: BLOCK_REASON };
			return;
		}
		// Bash commands run as attached pi-bg tasks: one still running after
		// AUTO_BACKGROUND_S moves to the background by itself, and a dispatched
		// worker's also moves when its coordinator writes. Not in gentle subagent
		// children (their session ends with the answer, killing the task) nor in
		// non-interactive runs.
		const interactive = ctx.hasUI === true && !gentleChild;
		if (!(interactive || workerActive()) || !manager || env.PI_BG_ATTACH === "0" || !attachable(command)) return;
		try {
			const firstLine = command.split("\n")[0];
			// The bash call's own timeout still applies, also in the background. Without
			// one there is no deadline in the foreground, as with Pi's bash; moving to
			// the background adds DETACHED_DEFAULT_TIMEOUT_S so nothing runs away.
			const timeoutMs = typeof input.timeout === "number" && input.timeout > 0 ? input.timeout * 1000 : undefined;
			const snap = await manager.start({ command, cwd: ctx.cwd, label: `bash · ${firstLine.slice(0, 60)}`, attached: true, timeoutMs });
			attachedCalls.set(event.toolCallId, snap.id);
			// Capped at 24 h: a larger setTimeout delay overflows and fires at once.
			const autoS = Math.min(Number(env.PI_BG_AUTO_BACKGROUND_S ?? AUTO_BACKGROUND_S), MAX_TIMEOUT_S);
			if (interactive && Number.isFinite(autoS) && autoS > 0) {
				const m = manager;
				const timer = setTimeout(() => {
					autoTimers.delete(event.toolCallId);
					if (m.get(snap.id)?.attached) m.detach(snap.id, "slow", autoS * 1000, DETACHED_DEFAULT_TIMEOUT_S * 1000);
				}, autoS * 1000);
				timer.unref?.();
				autoTimers.set(event.toolCallId, timer);
			}
			const when = [interactive && Number.isFinite(autoS) && autoS > 0 ? `after ${autoS}s` : "", workerActive() ? "if your coordinator writes" : ""].filter(Boolean).join(" or ");
			input.command = `# pi-bg ${snap.id} (${when ? `moves to the background ${when}` : "attached pi-bg task"}): ${firstLine.slice(0, 200)}\n${attachCommand(process.execPath, ATTACH_CLIENT, snap.logPath, snap.outputOffset, snap.id)}`;
		} catch {
			/* too many tasks or no log dir: run it the ordinary way */
		}
		return;
	});

	pi.on("tool_execution_end", (event) => {
		const timer = autoTimers.get(event.toolCallId);
		if (timer) {
			clearTimeout(timer);
			autoTimers.delete(event.toolCallId);
		}
		const id = attachedCalls.get(event.toolCallId);
		if (!id) return;
		attachedCalls.delete(event.toolCallId);
		// Still attached after the call ended: the bash tool timed out or was aborted.
		if (manager?.get(id)?.attached) manager.cancel(id);
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
			"Run a shell command in the background and return at once; a 'pi-bg' message with the exit status and last lines arrives when it ends (an idle session wakes). " +
			"Pick by expected duration. Use bg_run for 10 s or more, or never-ending: test suites, builds, installs, deploys, docker builds, log tails, and any waiting (CI via `gh run watch` / `gh pr checks --watch`, polling loops, service restarts). Several slow commands at once: one bg_run each, in the same turn. " +
			"Use bash for everything else, including anything under ~10 s (ls, cat, grep, git status, reading files): it returns the output directly. A bash call still running after 10 s moves here by itself; do not rely on that. " +
			"Never poll or sleep for a task: keep working or end the turn; bg_tail reads its log, bg_cancel stops it. " +
			"watch: notify when an output line matches a regex (`until` stops the task at the first match unless keep_running; `each` notifies per match). " +
			"timeout_s: the longest it may reasonably take (max 24 h); reaching it stops the task. Tasks die with the session.",
		promptSnippet: "bg_run: slow (10 s or more) or never-ending commands and waits, in the background; bash for everything faster.",
		parameters: Type.Object(
			{
				command: Type.String({ description: "Shell command line, run with bash -c." }),
				cwd: Type.Optional(Type.String({ description: "Working directory; defaults to the session cwd." })),
				label: Type.Optional(Type.String({ description: "Short human label, e.g. 'serverful verify'." })),
				timeout_s: Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_S, description: "Required deadline in seconds (1 to 86400); the task is stopped and reported when reached." }),
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
			const timeoutS = params.timeout_s;
			if (!Number.isInteger(timeoutS) || timeoutS < 1 || timeoutS > MAX_TIMEOUT_S) throw new Error(`timeout_s is required: an integer from 1 to ${MAX_TIMEOUT_S} seconds.`);
			const cwd = params.cwd || ctx.cwd;
			if (!(await isDirectory(cwd))) throw new Error(`cwd ${cwd} does not exist or is not a directory.`);
			const task = await need().start({
				command: params.command,
				cwd,
				label: params.label,
				timeoutMs: timeoutS * 1000,
				watch: params.watch ? { pattern: params.watch.pattern, flags: params.watch.flags, mode: params.watch.mode, keepRunning: params.watch.keep_running, maxEvents: params.watch.max_events } : undefined,
			});
			const deadline = ` · deadline ${formatDuration(timeoutS * 1000)}`;
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

	// ---- Orca coordinator tools (hidden only in dispatched workers) --------

	if (orcaEnabled) {
		pi.registerTool({
			name: "orca_ack",
			label: "Orca ack",
			description:
				"This session coordinates an Orca Run through pi-bg, which owns the Run mailbox: it keeps the only waiter and delivers each batch as an 'Orca delivery' message (heartbeat-only batches are acknowledged automatically). Never run a consuming `orca orchestration check` or orca-wait yourself. " +
				"Acknowledge a delivery after processing every message in it (questions answered, worker_done validated, release/retain decided); the mailbox stays paused until then. " +
				"If Orca already holds the next batch it is returned in this result and becomes the pending delivery.",
			parameters: Type.Object({ deliveryId: Type.Optional(Type.String({ description: "The delivery to acknowledge; defaults to the pending one." })) }, { additionalProperties: false }),
			executionMode: "sequential",
			renderResult: compactResult,
			async execute(_id, params, _signal, _onUpdate, ctx) {
				ctxRef = ctx;
				if (!bridge) throw new Error("The Orca bridge is not running in this session.");
				const deliveryId = params.deliveryId || bridge.state.pending?.id;
				if (!deliveryId) throw new Error(`No pending Orca delivery; nothing to acknowledge (bridge ${bridge.state.phase}).`);
				const reply = await bridge.ack(deliveryId);
				if (!reply.ok) throw new Error(reply.text);
				const text = reply.next ? `${reply.text}\n\n${formatDelivery(reply.next, { note: reply.note, rawPath: reply.rawPath })}` : reply.text;
				return { content: [{ type: "text", text }], details: { next: reply.next?.id } };
			},
		});

		pi.registerTool({
			name: "orca_workers",
			label: "Orca workers",
			description: "Show the fleet of the bound Run (read-only): each open worker with outcome, activity and its age, agent and model, what it is doing now (from its terminal) and how long that has been unchanged, liveness, attention and nextAction, plus tasks that have no worker. inbox=true adds the mailbox bridge state and the pending delivery (e.g. after compaction); it never consumes or acknowledges mail.",
			parameters: Type.Object({
				all: Type.Optional(Type.Boolean({ description: "Include settled and released workers." })),
				refresh: Type.Optional(Type.Boolean({ description: "Poll Orca now instead of using the last poll." })),
				inbox: Type.Optional(Type.Boolean({ description: "Prepend the bridge state and the pending delivery." })),
			}, { additionalProperties: false }),
			renderResult: compactResult,
			async execute(_id, params) {
				const inbox = params.inbox ? `${inboxText()}\n\n` : "";
				if (!fleet || !fleet.runId) return { content: [{ type: "text", text: `${inbox}No Run is bound, so there is no fleet to show.` }], details: undefined };
				if (params.refresh || fleet.lastPollAt === null) {
					await fleet.poll();
					await fleet.readActivity();
				}
				const header = fleet.lastError ? `(warning: ${fleet.lastError})\n` : "";
				return { content: [{ type: "text", text: inbox + header + formatWorkersTable(fleet.state, fleet.runId, now(), { all: params.all, activity: fleet.activity, details: fleet.details }) }], details: undefined };
			},
		});

		pi.registerTool({
			name: "orca_watch",
			label: "Orca watch",
			description:
				"Ask to be notified about one worker, with a note to yourself that comes back verbatim in the notice (e.g. 'when A0 settles, launch the A1 review'). Every worker of the Run is already watched for stalls, loops, prompts, scope violations, exits and attention; this adds events (settled, any activity change) and the note. The note survives /reload.",
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
				if (!fleet.worker(params.dispatchId)) await fleet.poll();
				if (!fleet.worker(params.dispatchId)) throw new Error(`Dispatch ${params.dispatchId} is not in the bound Run; use the dispatch id (ctx_...) from orca_workers.`);
				const watch = { dispatchId: params.dispatchId, on: (params.on?.length ? params.on : ["settled", "stalled", "blocked"]) as WatchOn[], note: clip(params.note ?? "", 500), createdAt: now() };
				fleet.addWatch(watch);
				pi.appendEntry(WATCH_ENTRY, watch);
				return { content: [{ type: "text", text: `Watching ${params.dispatchId} for ${watch.on.join(", ")}${watch.note ? ` with note: ${watch.note}` : ""}.` }], details: undefined };
			},
		});

		pi.registerTool({
			name: "orca_release",
			label: "Orca release",
			description: "Release settled workers you decided to clean up: give exactly one of dispatchId (one worker) or all=true (every reclaimable settled worker); never infer release intent. Uses Orca worker-release first; only after a fresh positive exited verdict may it close that exact terminal as a fallback. It never releases a live, unsettled, user-owned or unverifiable worker.",
			parameters: Type.Object({
				dispatchId: Type.Optional(Type.String({ description: "Dispatch id (ctx_...) of one settled worker." })),
				all: Type.Optional(Type.Boolean({ description: "Release every reclaimable settled worker." })),
			}, { additionalProperties: false }),
			renderResult: compactResult,
			async execute(_id, params, _signal, _onUpdate, ctx) {
				ctxRef = ctx;
				if (!fleet || !fleet.runId) throw new Error("No Run is bound, so there are no workers to release.");
				await fleet.poll();
				const candidates = releaseSelection([...fleet.state.workers.values()].map((t) => t.row), { dispatchId: params.dispatchId, all: params.all });
				if (!candidates.length) return { content: [{ type: "text", text: "No settled workers are reclaimable." }], details: undefined };
				const results = [];
				for (const row of candidates) {
					const outcome = await releaseOne(row, {
						run: async (args) => {
							const capture = await runOrcaCli(env.PI_BG_ORCA_BIN || "orca", args, { cwd: ctx.cwd, env });
							return { doc: extractJson(capture.stdout), exitCode: capture.exitCode };
						},
						refresh: async (dispatchId) => {
							await fleet!.poll();
							return fleet!.worker(dispatchId);
						},
						resolved: (dispatchId) => {
							fleet!.markReleased(dispatchId);
							pi.appendEntry(RELEASE_RESOLVED_ENTRY, { runId: fleet!.runId, dispatchId });
						},
					});
					results.push(outcome);
				}
				await fleet.persist();
				await fleet.poll();
				refresh();
				return { content: [{ type: "text", text: results.map((r) => `${r.dispatchId}: ${r.status} · ${r.detail}`).join("\n") }], details: { results } };
			},
		});

		pi.registerTool({
			name: "orca_screen",
			label: "Orca screen",
			description: "Read a bounded, trimmed tail of one worker's terminal with spinner/footer noise removed. Read-only; preserves interactive questions and visible options.",
			parameters: Type.Object({
				dispatchId: Type.String({ description: "Dispatch id (ctx_...) of the worker." }),
				lines: Type.Optional(Type.Integer({ minimum: 5, maximum: 80, description: "Lines of screen tail (default 30)." })),
			}, { additionalProperties: false }),
			renderResult: compactResult,
			async execute(_id, params, _signal, _onUpdate, ctx) {
				if (!fleet || !fleet.runId) throw new Error("No Run is bound.");
				const worker = fleet.worker(params.dispatchId);
				if (!worker) throw new Error(`Dispatch ${params.dispatchId} is not in the bound Run.`);
				const limit = params.lines ?? 30;
				const capture = await runOrcaCli(env.PI_BG_ORCA_BIN || "orca", ["orchestration", "worker-read", "--dispatch", params.dispatchId, "--source", "terminal", "--limit", String(limit), "--json"], { cwd: ctx.cwd, env });
				const doc = extractJson(capture.stdout) as { ok?: unknown; result?: unknown } | undefined;
				const result = doc?.ok === true && doc.result && typeof doc.result === "object" ? (doc.result as Record<string, unknown>) : undefined;
				const terminal = result?.terminal && typeof result.terminal === "object" ? (result.terminal as Record<string, unknown>) : undefined;
				const tail = Array.isArray(terminal?.tail) ? terminal.tail.filter((line): line is string => typeof line === "string") : [];
				const screen = trimWorkerScreen(tail, limit).map(clean).join("\n");
				return { content: [{ type: "text", text: `Worker ${params.dispatchId} · ${worker.activity}${screen ? `\n${screen}` : "\n(no terminal output)"}` }], details: { dispatchId: params.dispatchId, lines: limit } };
			},
		});

		pi.registerTool({
			name: "orca_config",
			label: "Orca config",
			description: "Set the bound Run's card label and/or configure the model-free worker watchdog; give label, watchdog or both. label: a short current focus (max 80 chars) that survives reload; empty clears it. watchdog: defaults are 2-minute scans, 10-minute unchanged-screen stall, 6-minute waiting-loop detection, 3-minute release grace, 30-minute finding cooldown; scopeGlobs override each Task spec's Allowed edit surfaces ([] uses the spec); enabled=false turns it off. The watchdog only reports new findings; it never writes to worker repos or steers/releases workers.",
			parameters: Type.Object({
				label: Type.Optional(Type.String({ maxLength: 80, description: "Short current focus for the Run card; empty clears it." })),
				watchdog: Type.Optional(Type.Object({
					enabled: Type.Optional(Type.Boolean()),
					cadenceMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
					stallMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 360 })),
					loopMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 360 })),
					waitRepeatCount: Type.Optional(Type.Integer({ minimum: 2, maximum: 10 })),
					cooldownMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1440 })),
					releaseGraceMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1440 })),
					scopeGlobs: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 100 })),
				}, { additionalProperties: false, description: "Watchdog settings; durations in minutes." })),
			}, { additionalProperties: false }),
			renderResult: compactResult,
			async execute(_id, params) {
				if (!fleet || !fleet.runId) throw new Error("No Run is bound.");
				if (params.label === undefined && params.watchdog === undefined) throw new Error("Give label or watchdog (or both).");
				const out: string[] = [];
				if (params.label !== undefined) {
					const label = await fleet.setLabel(params.label);
					out.push(label ? `Run card label set to: ${label}` : "Run card label cleared; showing current worker task titles instead.");
				}
				if (params.watchdog) {
					const w = params.watchdog;
					const patch: Partial<WatchdogConfig> = {};
					if (w.enabled !== undefined) patch.enabled = w.enabled;
					if (w.cadenceMinutes !== undefined) patch.cadenceMs = w.cadenceMinutes * 60_000;
					if (w.stallMinutes !== undefined) patch.stallMs = w.stallMinutes * 60_000;
					if (w.loopMinutes !== undefined) patch.loopMs = w.loopMinutes * 60_000;
					if (w.waitRepeatCount !== undefined) patch.waitRepeatCount = w.waitRepeatCount;
					if (w.cooldownMinutes !== undefined) patch.cooldownMs = w.cooldownMinutes * 60_000;
					if (w.releaseGraceMinutes !== undefined) patch.releaseGraceMs = w.releaseGraceMinutes * 60_000;
					if (w.scopeGlobs !== undefined) patch.scopeGlobs = w.scopeGlobs;
					const config = await fleet.configureWatchdog(patch);
					out.push(`Watchdog ${config.enabled ? "enabled" : "disabled"} · cadence ${formatDuration(config.cadenceMs)} · stall ${formatDuration(config.stallMs)} · loop ${formatDuration(config.loopMs)} · release grace ${formatDuration(config.releaseGraceMs)} · cooldown ${formatDuration(config.cooldownMs)} · scope ${config.scopeGlobs.length ? config.scopeGlobs.join(", ") : "from task specs"}`);
				}
				refresh();
				return { content: [{ type: "text", text: out.join("\n") }], details: undefined };
			},
		});
	}

	// ---- commands -----------------------------------------------------------

	pi.registerCommand("bg", {
		description: "pi-bg: `/bg` lists tasks · `/bg kill <id|all>` · `/bg card on|off|collapse|fold` (a click on a card also folds it).",
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
			if (verb === "card" && target === "fold") {
				// Fold both cards to one line each, or unfold them if any is folded.
				const unfold = foldedCards.size > 0;
				foldedCards.clear();
				if (!unfold) for (const key of [CARD_KEY, ORCA_CARD_KEY]) foldedCards.add(key);
				cardTui?.requestRender();
				ctx.ui.notify(unfold ? "pi-bg cards unfolded" : "pi-bg cards folded", "info");
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
				const word = arg.toLowerCase();
				if (word === "off") b.turnOff();
				else if (word === "on") b.turnOn();
				else if (/^run_[A-Za-z0-9]+$/.test(arg)) b.watchRun(arg);
				else if (word && word !== "status") {
					// A typo must not replace the bound Run and drop its pending delivery.
					ctx.ui.notify(`Usage: /orca-watch [status|on|off|run_<id>]; "${clip(arg, 40)}" is none of them, nothing changed.`, "warning");
					return;
				}
				const s = b.state;
				const fleetLine = fleet?.runId ? `\n${formatWorkersTable(fleet.state, fleet.runId, now(), { activity: fleet.activity, details: fleet.details }).split("\n").slice(0, 8).join("\n")}` : "";
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
