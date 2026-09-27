// Wake budget for model-free notices (fleet watch). Pure and clock-injected.
// A burst (restart, many workers settling together) must not become a storm
// of model turns: at most `maxWakes` wakes per `windowMs`; beyond that the
// notice is still recorded for the next turn but does not start one.

export interface WakeBudget {
	windowMs: number;
	maxWakes: number;
	wakes: number[];
}

export function createWakeBudget(maxWakes = 4, windowMs = 10 * 60_000): WakeBudget {
	return { windowMs, maxWakes, wakes: [] };
}

/** Returns whether this notice may start a turn, and the updated budget. */
export function takeWake(budget: WakeBudget, now: number): { allowed: boolean; budget: WakeBudget } {
	const wakes = budget.wakes.filter((t) => now - t < budget.windowMs);
	if (wakes.length >= budget.maxWakes) return { allowed: false, budget: { ...budget, wakes } };
	return { allowed: true, budget: { ...budget, wakes: [...wakes, now] } };
}
