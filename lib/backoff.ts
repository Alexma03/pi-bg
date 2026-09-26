// Exponential backoff with bounded jitter. Pure: the random source is
// injected so tests are deterministic.

export interface BackoffPolicy {
	baseMs: number;
	maxMs: number;
	/** Fraction of the delay used as +/- jitter, 0..1. */
	jitter: number;
}

export const TRANSPORT_BACKOFF: BackoffPolicy = { baseMs: 1_000, maxMs: 60_000, jitter: 0.2 };
export const WAITER_EXISTS_BACKOFF: BackoffPolicy = { baseMs: 15_000, maxMs: 120_000, jitter: 0.1 };

/** Delay before retry number `attempt` (0-based). */
export function backoffDelay(policy: BackoffPolicy, attempt: number, random: () => number = Math.random): number {
	const exponent = Math.min(Math.max(0, attempt), 20);
	const raw = Math.min(policy.maxMs, policy.baseMs * 2 ** exponent);
	const spread = raw * policy.jitter;
	const jittered = raw - spread + random() * 2 * spread;
	return Math.max(0, Math.round(Math.min(policy.maxMs, jittered)));
}
