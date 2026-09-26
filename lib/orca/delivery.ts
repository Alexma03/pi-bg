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

/** Model-facing text of one delivery. Bounded and redacted. */
export function formatDelivery(delivery: Delivery, options: FormatOptions = {}): string {
	const bodyMax = options.bodyMax ?? 2_000;
	const payloadMax = options.payloadMax ?? 500;
	const totalMax = options.totalMax ?? 10_000;
	const actionable = actionableMessages(delivery);
	const beats = heartbeatCount(delivery);
	const flags = [delivery.replayed ? "REPLAY" : "", beats ? `+${beats} heartbeat${beats === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
	const lines: string[] = [];
	lines.push(`Orca delivery ${delivery.id} · run ${delivery.runId || "?"} · ${actionable.length} message${actionable.length === 1 ? "" : "s"}${flags ? ` · ${flags}` : ""}`);
	if (options.note) lines.push(options.note);
	actionable.forEach((m, index) => {
		const priority = m.priority && m.priority !== "normal" ? ` [${m.priority.toUpperCase()}]` : "";
		lines.push("");
		lines.push(`${index + 1}. ${m.type}${priority} from ${clean(m.from) || "?"} · id ${m.id}`);
		if (m.subject) lines.push(`   Subject: ${clip(clean(m.subject), 300)}`);
		if (m.body) lines.push(indent(clip(clean(m.body), bodyMax)));
		if (m.payload) lines.push(`   Payload: ${clip(clean(m.payload), payloadMax)}`);
		if (m.type === "question") lines.push(`   Answer: orca orchestration reply --id ${m.id} --body "..." --json`);
	});
	lines.push("");
	lines.push(`Process every message above as the Orca orchestration guide requires (answer questions, validate each worker_done against its Dispatch, decide release/retain), then call orca_ack with deliveryId "${delivery.id}". Do not run \`orca orchestration check\` yourself: pi-bg owns the Run waiter.`);
	if (options.rawPath) lines.push(`Raw batch: ${options.rawPath}`);
	return clip(lines.join("\n"), totalMax);
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => `   ${line}`)
		.join("\n");
}
