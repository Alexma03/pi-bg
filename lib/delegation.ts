// Delegation guide added to the system prompt of a Pi session inside Orca.
// Tool descriptions alone cannot carry it: the choice between a Gentle
// subagent and an Orca worker is made before any of those tools is called,
// and some hosts drop promptGuidelines. Outside Orca there is no worker to
// start, so nothing is added there.

export interface DelegationContext {
	/** Interactive session in an Orca terminal (not a Gentle subagent child). */
	orca: boolean;
	/** This session was dispatched as an Orca worker. */
	worker: boolean;
}

export function delegationGuide(context: DelegationContext): string | undefined {
	if (!context.orca) return undefined;
	const lines = [
		"## Delegation: pick the layer by what the work needs",
		"- A shell command with no reasoning (tests, builds, installs, waiting on CI or a deploy): bg_run.",
		"- A bounded unit on one front that returns its result to this conversation (explore, verify, one writer in this or another worktree of the same clone): a Gentle subagent.",
		"- Delegated work that itself needs orchestration (several fronts, its own plan and subagents, long autonomous work, or parallel writers each in its own worktree): an Orca worker, i.e. a new Pi session that orchestrates it. Use the orchestration skill; supervise it through Orca deliveries and orca_workers.",
		"- Handing work off for good, with no supervision: orca-cli.",
		"These layers combine: an Orca worker uses Gentle subagents and bg_run for its own task.",
	];
	if (context.worker) {
		lines.push("You are an Orca worker: you still orchestrate your own task, so keep using Gentle subagents and bg_run as above. Report progress and results to your coordinator through Orca.");
	}
	return lines.join("\n");
}
