// Worker-side supervision. When Orca dispatches a Task to this Pi session it
// types a preamble (Task/Dispatch IDs, lifecycle commands, "=== TASK ===")
// into the editor. pi-bg reads that input model-free, tracks whether the
// worker's worker_done actually went through, and reminds it when a
// completed turn ends without one. Pure; the extension wires `input`,
// `tool_result` and `agent_before_settle`.

export interface WorkerIdentity {
	taskId: string;
	dispatchId: string;
	workerHandle: string;
}

/** Recognise an Orca worker preamble and extract its lifecycle identity. */
export function parsePreamble(text: string): WorkerIdentity | undefined {
	if (!text.includes("=== TASK ===")) return undefined;
	const dispatchId = /--dispatch-id\s+(ctx_[A-Za-z0-9]+)/.exec(text)?.[1];
	const taskId = /--task-id\s+(task_[A-Za-z0-9]+)/.exec(text)?.[1];
	if (!dispatchId || !taskId) return undefined;
	const workerHandle = /--from\s+(term_[A-Za-z0-9-]+)/.exec(text)?.[1] ?? "";
	return { taskId, dispatchId, workerHandle };
}

export interface WorkerState {
	identity: WorkerIdentity | null;
	doneSent: boolean;
	escalated: boolean;
	/** Reminders since the last input (coordinator follow-up or user). */
	reminders: number;
	lastReminderAt: number | null;
}

export const MAX_REMINDERS = 2;
export const REMINDER_GAP_MS = 10 * 60_000;

export function initialWorker(): WorkerState {
	return { identity: null, doneSent: false, escalated: false, reminders: 0, lastReminderAt: null };
}

/**
 * A new preamble starts a new Dispatch. Any other input is new direction
 * (a coordinator follow-up typed by Orca, or the user), so the reminder
 * budget starts again.
 */
export function onInput(state: WorkerState, text: string): WorkerState {
	const identity = parsePreamble(text);
	if (identity && state.identity?.dispatchId !== identity.dispatchId) return { ...initialWorker(), identity };
	if (!state.identity) return state;
	if (state.reminders === 0) return state;
	return { ...state, reminders: 0, lastReminderAt: null };
}

/**
 * True when a lifecycle command's tool result shows Orca accepted it: the
 * `--json` envelope, or the plain `Sent msg_…` receipt printed without `--json`.
 */
export function acceptedByOrca(output: string, isError: boolean): boolean {
	if (isError) return false;
	if (/^Sent msg_[A-Za-z0-9]+\s*$/m.test(output)) return true;
	return /"ok"\s*:\s*true/.test(output) && !/"ok"\s*:\s*false/.test(output);
}

/** Record a lifecycle send only once Orca accepted it (tool_result). */
export function onLifecycleResult(state: WorkerState, kinds: string[], command: string, accepted: boolean): WorkerState {
	if (!state.identity || !accepted) return state;
	if (!command.includes(state.identity.dispatchId) && !command.includes(state.identity.taskId)) return state;
	if (kinds.includes("worker-done")) return { ...state, doneSent: true };
	if (kinds.includes("escalation")) return { ...state, escalated: true };
	return state;
}

export interface SettleContext {
	outcome: string;
	now: number;
	/** Background tasks running or messages queued: the pause is intentional. */
	busy: boolean;
}

/**
 * At agent_before_settle: remind when a completed turn ended without
 * worker_done, at most MAX_REMINDERS times per input and REMINDER_GAP_MS
 * apart. Aborted or failed turns belong to the user; never remind then.
 */
export function reminderFor(state: WorkerState, ctx: SettleContext): { state: WorkerState; text?: string } {
	if (!state.identity || state.doneSent || ctx.outcome !== "completed" || ctx.busy) return { state };
	if (state.reminders >= MAX_REMINDERS) return { state };
	if (state.lastReminderAt !== null && ctx.now - state.lastReminderAt < REMINDER_GAP_MS) return { state };
	const { dispatchId, taskId } = state.identity;
	const text =
		`pi-bg: you are the Orca worker for Task ${taskId} / Dispatch ${dispatchId} and this turn is ending without worker_done. ` +
		"If the task is finished, send worker_done now with --outcome succeeded or failed exactly as your preamble shows. " +
		`If you are blocked, use the preamble's \`orchestration ask\` (or an escalation) instead of stopping silently${state.escalated ? " (you already escalated; if you are waiting on the coordinator, say so and stop)" : ""}. ` +
		"If you are deliberately waiting (for example on a bg_run notice), say so in one line. If the user gave you a direct instruction that replaced the task, ignore this reminder.";
	return { state: { ...state, reminders: state.reminders + 1, lastReminderAt: ctx.now }, text };
}
