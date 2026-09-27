// Worker-side mail: Orca does not interrupt a busy worker when its
// coordinator sends a follow-up (`send --to dispatch:<id>` only enqueues). A
// dispatched Pi worker with pi-bg peeks its own mailbox (read-only
// `check --terminal <handle> --peek`), and on new coordinator mail it tells
// the model to read it now. The extension also detaches any blocking command
// into the background first (see lib/tasks/attach-client.mjs). Pure.

import { clip, sanitizeTerminal } from "../text.ts";
import { redact } from "../redact.ts";
import type { WorkerIdentity } from "./worker.ts";

export interface MailMessage {
	id: string;
	from: string;
	type: string;
	subject: string;
	body: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Unread messages from a `check --peek --json` result, minus the worker's own mail and heartbeats. */
export function parsePeek(result: unknown, selfHandle: string): MailMessage[] {
	const r = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
	const rows = Array.isArray(r.messages) ? r.messages : [];
	return rows
		.map((raw) => {
			const m = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
			return { id: str(m.id), from: str(m.from_handle), type: str(m.type) || "message", subject: str(m.subject), body: str(m.body) };
		})
		.filter((m) => m.id && m.type !== "heartbeat" && (!selfHandle || m.from !== selfHandle));
}

export interface MailState {
	/** When each message id was first announced. */
	announced: Map<string, number>;
	/** Reminders sent for the currently unread set. */
	reminders: number;
	lastNoticeAt: number | null;
}

export const MAIL_REMIND_MS = 5 * 60_000;
export const MAIL_MAX_REMINDERS = 2;

export function initialMail(): MailState {
	return { announced: new Map(), reminders: 0, lastNoticeAt: null };
}

export interface MailDecision {
	state: MailState;
	/** Messages to announce now (new ones, or all unread on a reminder). */
	announce: MailMessage[];
	reminder: boolean;
}

/**
 * New unread messages are announced once. If some stay unread (the worker
 * did not run its `check`), they are announced again after MAIL_REMIND_MS,
 * at most MAIL_MAX_REMINDERS times. Messages that were read drop out.
 */
export function decideMail(prev: MailState, unread: MailMessage[], now: number): MailDecision {
	const ids = new Set(unread.map((m) => m.id));
	const announced = new Map([...prev.announced].filter(([id]) => ids.has(id)));
	const fresh = unread.filter((m) => !announced.has(m.id));
	if (fresh.length) {
		for (const m of fresh) announced.set(m.id, now);
		return { state: { announced, reminders: 0, lastNoticeAt: now }, announce: fresh, reminder: false };
	}
	const due = unread.length > 0 && prev.lastNoticeAt !== null && now - prev.lastNoticeAt >= MAIL_REMIND_MS && prev.reminders < MAIL_MAX_REMINDERS;
	if (due) return { state: { announced, reminders: prev.reminders + 1, lastNoticeAt: now }, announce: unread, reminder: true };
	return { state: { ...prev, announced, ...(unread.length ? {} : { reminders: 0, lastNoticeAt: null }) }, announce: [], reminder: false };
}

const clean = (text: string): string => redact(sanitizeTerminal(text));

export function formatMailNotice(messages: MailMessage[], identity: WorkerIdentity, options: { reminder?: boolean; detached?: Array<{ id: string; command: string }> } = {}): string {
	const handle = identity.workerHandle || "<your terminal handle>";
	const lines = [
		options.reminder
			? `Orca: ${messages.length} message(s) from your coordinator are still unread (Task ${identity.taskId} / Dispatch ${identity.dispatchId}).`
			: `Orca: your coordinator sent ${messages.length} new message(s) (Task ${identity.taskId} / Dispatch ${identity.dispatchId}).`,
	];
	for (const m of messages.slice(0, 5)) {
		lines.push(`- ${m.type}${m.subject ? `: ${clip(clean(m.subject), 120)}` : ""}`);
		if (m.body) lines.push(`  ${clip(clean(m.body).replace(/\s*\n\s*/g, " "), 600)}`);
	}
	if (messages.length > 5) lines.push(`- … ${messages.length - 5} more`);
	for (const t of options.detached ?? []) lines.push(`Your running command \`${clip(clean(t.command).replace(/\s*\n\s*/g, " "), 100)}\` was moved to the background as ${t.id} and keeps running; its pi-bg notice arrives when it ends (bg_tail / bg_cancel manage it).`);
	lines.push(`Read them now, before continuing: \`orca orchestration check --terminal ${handle} --json\` (this marks them read). Then follow them: they may redirect, narrow or cancel your task.`);
	return lines.join("\n");
}

/** Commands that stay in the foreground: Orca lifecycle calls, which pi-bg inspects by their result. */
export function attachable(command: string): boolean {
	return Boolean(command.trim()) && !/(^|[\s;&|(`$])orca(-dev|-ide)?\s/.test(command);
}

/** The bash command that follows an attached task: `exec node attach-client.mjs <log> <offset> <id>`. */
export function attachCommand(nodePath: string, clientPath: string, logPath: string, offset: number, id: string): string {
	const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
	return `exec ${q(nodePath)} ${q(clientPath)} ${q(logPath)} ${offset} ${id}`;
}
