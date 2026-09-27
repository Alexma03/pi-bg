// TUI view of an Orca delivery message: one glyph per message type, worker_done
// coloured by outcome, one line per message when collapsed. Pure; the model
// still receives the plain text from formatDelivery.

import type { Delivery, OrcaMessage } from "../orca/delivery.ts";
import { actionableMessages, heartbeatCount } from "../orca/delivery.ts";
import { redact } from "../redact.ts";
import { clip, sanitizeTerminal } from "../text.ts";

export type ViewTone = "text" | "success" | "error" | "warning" | "accent" | "dim";

export interface ViewLine {
	text: string;
	tone: ViewTone;
}

/** Compact per-message facts stored in the custom message details. */
export interface MessageFact {
	id: string;
	type: string;
	from: string;
	subject: string;
	outcome?: string;
	priority?: string;
	body?: string;
}

export function workerOutcome(message: Pick<OrcaMessage, "payload" | "type">): string | undefined {
	if (message.type !== "worker_done" || !message.payload) return undefined;
	try {
		const parsed = JSON.parse(message.payload) as { outcome?: unknown };
		return typeof parsed.outcome === "string" ? parsed.outcome : undefined;
	} catch {
		return /"outcome"\s*:\s*"(\w+)"/.exec(message.payload)?.[1];
	}
}

const clean = (text: string, max: number): string => clip(redact(sanitizeTerminal(text)).replace(/\s+/g, " ").trim(), max);

export function messageFacts(delivery: Delivery): MessageFact[] {
	return actionableMessages(delivery)
		.slice(0, 50)
		.map((m) => ({
			id: m.id,
			type: m.type,
			from: clean(m.from, 60),
			subject: clean(m.subject, 160),
			...(workerOutcome(m) ? { outcome: workerOutcome(m) } : {}),
			...(m.priority && m.priority !== "normal" ? { priority: m.priority } : {}),
			body: clean(m.body, 600),
		}));
}

function glyph(f: MessageFact): { mark: string; tone: ViewTone } {
	switch (f.type) {
		case "worker_done":
			return f.outcome === "failed" ? { mark: "✖", tone: "error" } : { mark: "✔", tone: "success" };
		case "question":
			return { mark: "?", tone: "warning" };
		case "escalation":
			return { mark: "⚠", tone: "error" };
		case "decision_gate":
			return { mark: "◇", tone: "warning" };
		default:
			return { mark: "·", tone: "text" };
	}
}

export function deliveryView(details: { deliveryId?: string; runId?: string; messages?: MessageFact[]; heartbeats?: number; replay?: boolean; reminder?: boolean }, fallbackText: string, expanded: boolean): { title: string; tone: ViewTone; lines: ViewLine[] } {
	const facts = details.messages;
	if (!facts) {
		// Reminders and older messages: show the plain text.
		const lines = fallbackText.split("\n").map((text) => ({ text, tone: "text" as ViewTone }));
		return { title: lines.shift()?.text ?? "Orca", tone: details.reminder ? "warning" : "accent", lines: expanded ? lines : lines.slice(0, 6) };
	}
	const urgent = facts.some((f) => f.type === "question" || f.type === "escalation" || f.outcome === "failed");
	const title = `Orca · ${facts.length} message${facts.length === 1 ? "" : "s"}${details.heartbeats ? ` · +${details.heartbeats} heartbeat${details.heartbeats === 1 ? "" : "s"}` : ""}${details.replay ? " · REPLAY" : ""} · ${details.deliveryId ?? ""}`;
	const lines: ViewLine[] = [];
	for (const f of facts) {
		const g = glyph(f);
		const outcome = f.outcome ? ` ${f.outcome}` : "";
		const priority = f.priority ? ` [${f.priority.toUpperCase()}]` : "";
		lines.push({ text: `${g.mark} ${f.type}${outcome}${priority} · ${f.subject || "(no subject)"} · ${f.from}`, tone: g.tone });
		if (expanded && f.body) lines.push({ text: `    ${f.body}`, tone: "dim" });
	}
	if (!expanded && lines.length > 12) {
		const extra = lines.length - 12;
		lines.splice(12, lines.length, { text: `… ${extra} more`, tone: "dim" });
	}
	lines.push({ text: "processed? → orca_ack", tone: "dim" });
	return { title, tone: urgent ? "warning" : "accent", lines };
}

export { heartbeatCount };
