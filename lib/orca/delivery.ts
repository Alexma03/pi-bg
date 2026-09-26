// Orca mailbox deliveries: parsing, classification and the compact text the
// model receives. A Delivery is the whole oldest FIFO batch of the Run
// mailbox (up to 50 messages); Orca replays it until it is acknowledged.

import { redact } from "../redact.ts";
import { clip, sanitizeTerminal } from "../text.ts";

export interface OrcaMessage {
	id: string;
	type: string;
	from: string;
	to: string;
	subject: string;
	body: string;
	payload: string;
	priority: string;
	threadId: string;
	createdAt: string;
}

export interface Delivery {
	id: string;
	runId: string;
	messages: OrcaMessage[];
	/** Orca reports this batch was handed out before and not acknowledged. */
	replayed: boolean;
}

const str = (value: unknown): string => {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	if (typeof value === "object") {
		try {
			return JSON.stringify(value);
		} catch {
			return "";
		}
	}
	return String(value);
};

export function parseMessage(raw: unknown): OrcaMessage | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const row = raw as Record<string, unknown>;
	const id = str(row.id);
	if (!id) return undefined;
	return {
		id,
		type: str(row.type) || "status",
		from: str(row.from_handle ?? row.from),
		to: str(row.to_handle ?? row.to),
		subject: str(row.subject),
		body: str(row.body),
		payload: str(row.payload),
		priority: str(row.priority),
		threadId: str(row.thread_id),
		createdAt: str(row.created_at),
	};
}

/** Build a Delivery from a `check` result, or undefined when it carries none. */
export function parseDelivery(result: Record<string, unknown>): Delivery | undefined {
	const id = typeof result.deliveryId === "string" ? result.deliveryId : "";
	const rows = Array.isArray(result.messages) ? result.messages : [];
	if (!id) return undefined;
	const messages = rows.map(parseMessage).filter((m): m is OrcaMessage => m !== undefined);
	return { id, runId: str(result.runId), messages, replayed: result.replayed === true };
}

export const HEARTBEAT_TYPE = "heartbeat";

export function isHeartbeatOnly(delivery: Delivery): boolean {
	return delivery.messages.every((m) => m.type === HEARTBEAT_TYPE);
}

export function actionableMessages(delivery: Delivery): OrcaMessage[] {
	return delivery.messages.filter((m) => m.type !== HEARTBEAT_TYPE);
}

export function heartbeatCount(delivery: Delivery): number {
	return delivery.messages.length - actionableMessages(delivery).length;
}

/** Types that need the coordinator to act, ordered by urgency for the header. */
const URGENT_TYPES = ["question", "escalation", "worker_done", "decision_gate"];

export function typeSummary(delivery: Delivery): string {
	const counts = new Map<string, number>();
	for (const m of actionableMessages(delivery)) counts.set(m.type, (counts.get(m.type) ?? 0) + 1);
	return [...counts.entries()]
		.sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
		.map(([type, n]) => (n > 1 ? `${n}× ${type}` : type))
		.join(", ");
}

function rank(type: string): number {
	const index = URGENT_TYPES.indexOf(type);
	return index < 0 ? URGENT_TYPES.length : index;
}

export interface FormatOptions {
	bodyMax?: number;
	payloadMax?: number;
	totalMax?: number;
	/** Extra line under the header, e.g. why this is a replay. */
	note?: string;
	/** Where the full raw batch was saved. */
	rawPath?: string;
}

const clean = (text: string): string => redact(sanitizeTerminal(text));

/** Room reserved for the "… [N more chars]" marker of a clipped field. */
const CLIP_MARK = 24;

/**
 * Model-facing text of one delivery. Bounded and redacted.
 *
 * Every message keeps its header (type, sender, id, subject) and the closing
 * orca_ack instruction and raw-batch path are always present; only bodies and
 * payloads shrink, from a per-message share of `totalMax`, so a large batch
 * never hides later messages or the ack.
 */
export function formatDelivery(delivery: Delivery, options: FormatOptions = {}): string {
	const bodyMax = options.bodyMax ?? 2_000;
	const payloadMax = options.payloadMax ?? 500;
	const totalMax = options.totalMax ?? 10_000;
	const actionable = actionableMessages(delivery);
	const beats = heartbeatCount(delivery);
	const flags = [delivery.replayed ? "REPLAY" : "", beats ? `+${beats} heartbeat${beats === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
	const head: string[] = [];
	head.push(`Orca delivery ${delivery.id} · run ${delivery.runId || "?"} · ${actionable.length} message${actionable.length === 1 ? "" : "s"}${flags ? ` · ${flags}` : ""}`);
	if (options.note) head.push(options.note);
	const tail: string[] = [""];
	tail.push(`Process every message above as the Orca orchestration guide requires (answer questions, validate each worker_done against its Dispatch, decide release/retain), then call orca_ack with deliveryId "${delivery.id}". Do not run \`orca orchestration check\` yourself: pi-bg owns the Run waiter.`);
	if (options.rawPath) tail.push(`Raw batch: ${options.rawPath}`);

	// Mandatory lines per message first, then share what is left of totalMax.
	const subjectMax = actionable.length > 20 ? 80 : 300;
	const headers = actionable.map((m, index) => {
		const priority = m.priority && m.priority !== "normal" ? ` [${m.priority.toUpperCase()}]` : "";
		const lines = ["", `${index + 1}. ${m.type}${priority} from ${clip(clean(m.from), 80) || "?"} · id ${m.id}`];
		if (m.subject) lines.push(`   Subject: ${clip(clean(m.subject), subjectMax)}`);
		return lines;
	});
	const answers = actionable.map((m) => (m.type === "question" ? `   Answer: orca orchestration reply --id ${m.id} --body "..." --json` : undefined));
	const fixed = [...head, ...headers.flat(), ...answers.filter((a) => a !== undefined), ...tail].reduce((n, line) => n + line.length + 1, 0);
	const share = actionable.length ? Math.max(0, Math.floor((totalMax - fixed) / actionable.length)) : 0;

	const lines = [...head];
	actionable.forEach((m, index) => {
		lines.push(...headers[index]);
		let left = share;
		const payload = m.payload ? fit(clean(m.payload), Math.min(payloadMax, m.body ? Math.floor(left / 4) : left) - 13) : undefined;
		if (payload !== undefined) left -= payload.length + 13;
		if (m.body) {
			// The indent adds 3 chars per line; refit once when it overflows the share.
			const body = clean(m.body);
			const budget = Math.min(bodyMax, left - 1);
			let text = indent(fit(body, budget));
			if (text.length > left - 1) text = indent(fit(body, budget - (text.length - (left - 1))));
			lines.push(text);
		}
		if (payload !== undefined) lines.push(`   Payload: ${payload}`);
		const answer = answers[index];
		if (answer) lines.push(answer);
	});
	lines.push(...tail);
	return lines.join("\n");
}

/** Clip `text` to `max` including the marker, or name it omitted when there is no room. */
function fit(text: string, max: number): string {
	if (text.length <= max) return text;
	if (max - CLIP_MARK < 40) return `[${text.length} chars omitted; see raw batch]`;
	return clip(text, max - CLIP_MARK);
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => `   ${line}`)
		.join("\n");
}
