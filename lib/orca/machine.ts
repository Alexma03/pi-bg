// The Orca bridge state machine. Pure: `step(state, event)` returns the next
// state and the effects the driver must perform (spawn the waiter, inject a
// message, schedule a retry...). The driver owns processes and timers; this
// module owns every decision, so the whole protocol is unit-testable.
//
// Protocol (Orca 1.4.212 semantics):
//   waiting  one `check --wait` child with no --types is alive. Orca does not
//            type its pointer while an unfiltered waiter exists.
//   pending  an actionable delivery was injected and is NOT acknowledged. No
//            waiter runs (a wait would just replay it); the outstanding
//            delivery itself keeps Orca's pointer suppressed.
//   acking   orca_ack is running a synchronous `check --ack <id>`.
//   backoff  a CLI failure; a retry is scheduled.
//   fenced   this terminal no longer consumes the Run (consumer_fenced,
//            stable_pane_required...). The driver re-detects the Run.
//   off      bridge disabled or no Run bound.
// Heartbeat-only deliveries are acknowledged silently by re-arming the next
// wait with `--ack <id>` (atomic ack-then-wait).

import { backoffDelay, TRANSPORT_BACKOFF, WAITER_EXISTS_BACKOFF } from "../backoff.ts";
import type { CheckOutcome } from "./cli.ts";
import { heartbeatCount, isHeartbeatOnly, type Delivery } from "./delivery.ts";

export type Phase = "off" | "waiting" | "pending" | "acking" | "backoff" | "fenced";

export interface OrcaState {
	phase: Phase;
	runId: string | null;
	/** Run pinned by `/orca-watch <run>`: passed as --run, never re-detected. */
	explicitRun: boolean;
	pending: Delivery | null;
	pendingSince: number | null;
	reminded: boolean;
	/** Ack to piggy-back on the next wait (heartbeat-only batches). */
	ackCarry: string | null;
	/** Consecutive failures, drives backoff. */
	attempt: number;
	retryAt: number | null;
	reason: string;
	lastError: string | null;
	/** Delivery ids injected into this runtime (bounded). */
	injected: string[];
	/** Delivery ids we sent an ack for (bounded). */
	ackAttempted: string[];
	heartbeatsAcked: number;
	deliveriesInjected: number;
}

export type OrcaEvent =
	| { type: "enable"; runId: string; explicit: boolean }
	| { type: "disable"; reason: string }
	| { type: "waitResult"; outcome: CheckOutcome; sentAck: string | null; now: number }
	| { type: "retry"; now: number }
	| { type: "ackRequest"; deliveryId: string; now: number }
	| { type: "ackResult"; outcome: CheckOutcome; deliveryId: string; now: number }
	| { type: "tick"; now: number };

export type Effect =
	| { type: "spawnWait"; ack: string | null }
	| { type: "killWaiter" }
	| { type: "schedule"; delayMs: number }
	| { type: "cancelSchedule" }
	| { type: "inject"; delivery: Delivery; note?: string }
	| { type: "runAck"; deliveryId: string }
	| { type: "ackReply"; ok: boolean; text: string; next?: Delivery; note?: string }
	| { type: "redetect"; delayMs: number }
	| { type: "remind"; delivery: Delivery };

export interface StepResult {
	state: OrcaState;
	effects: Effect[];
}

/** Codes meaning this terminal is not (or no longer) the Run's consumer. */
export const FENCE_CODES = new Set([
	"consumer_fenced",
	"stable_pane_required",
	"run_required",
	"run_not_found",
	"not_run_consumer",
	"dispatch_inactive",
	"legacy_read_only",
]);

export const REMIND_AFTER_MS = 10 * 60_000;
const ID_HISTORY = 200;
const REDETECT_MS = 5_000;

export function initialState(): OrcaState {
	return {
		phase: "off",
		runId: null,
		explicitRun: false,
		pending: null,
		pendingSince: null,
		reminded: false,
		ackCarry: null,
		attempt: 0,
		retryAt: null,
		reason: "no Run bound",
		lastError: null,
		injected: [],
		ackAttempted: [],
		heartbeatsAcked: 0,
		deliveriesInjected: 0,
	};
}

const remember = (list: string[], id: string): string[] => (list.includes(id) ? list : [...list, id].slice(-ID_HISTORY));

export function step(state: OrcaState, event: OrcaEvent, random: () => number = Math.random): StepResult {
	switch (event.type) {
		case "enable": {
			if (state.runId === event.runId && state.phase !== "off" && state.phase !== "fenced") return { state, effects: [] };
			const next: OrcaState = {
				...initialState(),
				// Keep history so a replay after re-enable is still flagged.
				injected: state.injected,
				ackAttempted: state.ackAttempted,
				heartbeatsAcked: state.heartbeatsAcked,
				deliveriesInjected: state.deliveriesInjected,
				phase: "waiting",
				runId: event.runId,
				explicitRun: event.explicit,
				reason: "waiting",
			};
			return { state: next, effects: [{ type: "cancelSchedule" }, { type: "killWaiter" }, { type: "spawnWait", ack: null }] };
		}

		case "disable": {
			const next: OrcaState = { ...state, phase: "off", pending: null, pendingSince: null, ackCarry: null, retryAt: null, reason: event.reason };
			return { state: next, effects: [{ type: "cancelSchedule" }, { type: "killWaiter" }] };
		}

		case "retry": {
			if (state.phase !== "backoff") return { state, effects: [] };
			return { state: { ...state, phase: "waiting", retryAt: null, reason: "waiting" }, effects: [{ type: "spawnWait", ack: state.ackCarry }] };
		}

		case "waitResult":
			return onWaitResult(state, event.outcome, event.sentAck, event.now, random);

		case "ackRequest": {
			if (state.phase === "acking") return reply(state, false, "An acknowledgment is already running; wait for its result.");
			if (!state.pending || state.phase !== "pending") {
				const already = state.ackAttempted.includes(event.deliveryId);
				return reply(state, false, already ? `Delivery ${event.deliveryId} was already acknowledged.` : `No pending Orca delivery; nothing to acknowledge (bridge ${state.phase}).`);
			}
			if (state.pending.id !== event.deliveryId) {
				return reply(state, false, `Delivery ${event.deliveryId} is not the pending one; the pending delivery is ${state.pending.id}.`);
			}
			const next: OrcaState = { ...state, phase: "acking", ackAttempted: remember(state.ackAttempted, event.deliveryId), reason: "acknowledging" };
			return { state: next, effects: [{ type: "runAck", deliveryId: event.deliveryId }] };
		}

		case "ackResult":
			return onAckResult(state, event.outcome, event.deliveryId, event.now, random);

		case "tick": {
			if (state.phase !== "pending" || !state.pending || state.reminded || state.pendingSince === null) return { state, effects: [] };
			if (event.now - state.pendingSince < REMIND_AFTER_MS) return { state, effects: [] };
			return { state: { ...state, reminded: true }, effects: [{ type: "remind", delivery: state.pending }] };
		}
	}
}

function reply(state: OrcaState, ok: boolean, text: string): StepResult {
	return { state, effects: [{ type: "ackReply", ok, text }] };
}

function backoff(state: OrcaState, code: string, message: string, now: number, random: () => number): StepResult {
	const policy = code === "waiter_exists" ? WAITER_EXISTS_BACKOFF : TRANSPORT_BACKOFF;
	const delayMs = backoffDelay(policy, state.attempt, random);
	const reason = code === "waiter_exists" ? "another waiter holds this Run" : `orca error: ${code}`;
	const next: OrcaState = {
		...state,
		phase: "backoff",
		attempt: state.attempt + 1,
		retryAt: now + delayMs,
		reason,
		lastError: `${code}: ${message}`.slice(0, 300),
		// An ack that failed twice is dropped; Orca will replay the batch and
		// the heartbeat path acknowledges it again.
		ackCarry: state.attempt >= 1 ? null : state.ackCarry,
	};
	return { state: next, effects: [{ type: "schedule", delayMs }] };
}

function fence(state: OrcaState, code: string, message: string): StepResult {
	const next: OrcaState = {
		...state,
		phase: "fenced",
		pending: null,
		pendingSince: null,
		ackCarry: null,
		retryAt: null,
		reason: `not the Run consumer (${code})`,
		lastError: `${code}: ${message}`.slice(0, 300),
	};
	return { state: next, effects: [{ type: "cancelSchedule" }, { type: "killWaiter" }, ...(state.explicitRun ? [] : [{ type: "redetect" as const, delayMs: REDETECT_MS }])] };
}

function replayNote(state: OrcaState, delivery: Delivery): string | undefined {
	if (state.ackAttempted.includes(delivery.id)) return "REPLAY: Orca handed this delivery out again after an acknowledgment attempt, so it is still unacknowledged. Check what was already done before acting again.";
	if (state.injected.includes(delivery.id)) return "REPLAY: this delivery was already shown in this session and is still unacknowledged.";
	if (delivery.replayed) return "REPLAY: Orca handed this batch out before (for example before a /reload or restart) and it was never acknowledged. Check what was already done before acting again.";
	return undefined;
}

function acceptDelivery(state: OrcaState, delivery: Delivery, now: number, sentAck: string | null, random: () => number): StepResult {
	if (isHeartbeatOnly(delivery)) {
		// A heartbeat-only batch equal to the ack we just sent means the ack did
		// not apply; back off instead of spinning on it.
		if (sentAck && sentAck === delivery.id) {
			return backoff({ ...state, ackCarry: delivery.id }, "ack_not_applied", "heartbeat batch replayed after ack", now, random);
		}
		const next: OrcaState = {
			...state,
			phase: "waiting",
			attempt: 0,
			ackCarry: delivery.id,
			ackAttempted: remember(state.ackAttempted, delivery.id),
			heartbeatsAcked: state.heartbeatsAcked + heartbeatCount(delivery),
			reason: "waiting",
			lastError: null,
		};
		return { state: next, effects: [{ type: "spawnWait", ack: delivery.id }] };
	}
	const note = replayNote(state, delivery);
	const next: OrcaState = {
		...state,
		phase: "pending",
		attempt: 0,
		ackCarry: null,
		pending: delivery,
		pendingSince: now,
		reminded: false,
		injected: remember(state.injected, delivery.id),
		deliveriesInjected: state.deliveriesInjected + 1,
		reason: "pending ack",
		lastError: null,
	};
	return { state: next, effects: [{ type: "inject", delivery, ...(note ? { note } : {}) }] };
}

function onWaitResult(state: OrcaState, outcome: CheckOutcome, sentAck: string | null, now: number, random: () => number): StepResult {
	// A result that arrives after disable/fence/re-enable belongs to a killed
	// waiter; the driver tags results, but stay defensive here too.
	if (state.phase !== "waiting") return { state, effects: [] };
	const base: OrcaState = outcome.kind !== "error" && sentAck ? { ...state, ackCarry: null } : state;
	switch (outcome.kind) {
		case "delivery":
			return acceptDelivery(base, outcome.delivery, now, sentAck, random);
		case "empty":
			if (outcome.timedOut) return { state: { ...base, attempt: 0, lastError: null }, effects: [{ type: "spawnWait", ack: base.ackCarry }] };
			if (outcome.cancelled || outcome.connectionLost) return backoff(base, "connection_lost", "wait cancelled by Orca", now, random);
			return backoff(base, "empty_result", "wait returned without a delivery", now, random);
		case "error":
			if (FENCE_CODES.has(outcome.code)) return fence(base, outcome.code, outcome.message);
			return backoff(base, outcome.code, outcome.message, now, random);
	}
}

function onAckResult(state: OrcaState, outcome: CheckOutcome, deliveryId: string, now: number, random: () => number): StepResult {
	if (state.phase !== "acking" || !state.pending || state.pending.id !== deliveryId) {
		return reply(state, false, "The bridge state changed while acknowledging; see orca_inbox.");
	}
	const restore: OrcaState = { ...state, phase: "pending", reason: "pending ack" };
	switch (outcome.kind) {
		case "error": {
			if (FENCE_CODES.has(outcome.code)) {
				const fenced = fence(state, outcome.code, outcome.message);
				return { state: fenced.state, effects: [...fenced.effects, { type: "ackReply", ok: false, text: `Ack failed: this terminal is no longer the Run consumer (${outcome.code}). The bridge stopped; see /orca-watch status.` }] };
			}
			return { state: { ...restore, lastError: `${outcome.code}: ${outcome.message}`.slice(0, 300) }, effects: [{ type: "ackReply", ok: false, text: `Ack failed (${outcome.code}: ${outcome.message.slice(0, 200)}). The delivery is still pending; retry orca_ack.` }] };
		}
		case "delivery": {
			const nextDelivery = outcome.delivery;
			if (nextDelivery.id === deliveryId) {
				return { state: restore, effects: [{ type: "ackReply", ok: false, text: `Orca still reports ${deliveryId} outstanding; the ack did not apply. Retry orca_ack.` }] };
			}
			const cleared: OrcaState = { ...state, pending: null, pendingSince: null, phase: "waiting", reason: "waiting" };
			if (isHeartbeatOnly(nextDelivery)) {
				const next: OrcaState = {
					...cleared,
					ackCarry: nextDelivery.id,
					ackAttempted: remember(cleared.ackAttempted, nextDelivery.id),
					heartbeatsAcked: cleared.heartbeatsAcked + heartbeatCount(nextDelivery),
				};
				return { state: next, effects: [{ type: "spawnWait", ack: nextDelivery.id }, { type: "ackReply", ok: true, text: `Acknowledged ${deliveryId}. Waiter re-armed.` }] };
			}
			const accepted = acceptDelivery(cleared, nextDelivery, now, null, random);
			const note = accepted.effects.find((e): e is Extract<Effect, { type: "inject" }> => e.type === "inject")?.note;
			// The next batch is returned inline in the tool result, not injected.
			return {
				state: accepted.state,
				effects: [{ type: "ackReply", ok: true, text: `Acknowledged ${deliveryId}. The next delivery was already waiting:`, next: nextDelivery, ...(note ? { note } : {}) }],
			};
		}
		case "empty": {
			const next: OrcaState = { ...state, pending: null, pendingSince: null, phase: "waiting", reason: "waiting", ackCarry: null };
			return { state: next, effects: [{ type: "spawnWait", ack: null }, { type: "ackReply", ok: true, text: `Acknowledged ${deliveryId}. Waiter re-armed.` }] };
		}
	}
}
