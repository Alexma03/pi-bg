// Classifies shell commands the model runs through the bash tool, so the
// bridge can (a) block a second mailbox consumer and (b) notice Run binding
// changes. Heuristic by design: it splits on shell separators and inspects
// each simple command; quoting tricks can evade it, which only costs the
// protection, never correctness of the bridge itself.

export type OrcaCommandKind = "consuming-check" | "peek-check" | "bind" | "other";

const SEPARATORS = /\|\||&&|[;|&\n]|\$\(|`/;

function segments(command: string): string[] {
	return command
		.split(SEPARATORS)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** True when a segment invokes the orca CLI (bare, via path, or via env). */
function orcaSubcommand(segment: string): string[] | undefined {
	const tokens = segment.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ""));
	for (let i = 0; i < tokens.length; i++) {
		const base = tokens[i].split("/").pop() ?? "";
		if (base === "orca" || base === "orca-ide") return tokens.slice(i + 1);
	}
	return undefined;
}

export function classifyOrcaCommand(command: string): OrcaCommandKind[] {
	const kinds: OrcaCommandKind[] = [];
	for (const segment of segments(command)) {
		if (/(^|[\s/])orca-wait(\s|$)/.test(segment)) {
			kinds.push("consuming-check");
			continue;
		}
		const rest = orcaSubcommand(segment);
		if (!rest) continue;
		const [group, verb] = rest.filter((t) => !t.startsWith("-"));
		if (group !== "orchestration") continue;
		if (verb === "check") {
			kinds.push(rest.includes("--peek") || rest.includes("--all") ? "peek-check" : "consuming-check");
		} else if (verb === "run-create" || verb === "run-use") {
			kinds.push("bind");
		}
	}
	return kinds.length ? kinds : ["other"];
}

export const BLOCK_REASON =
	"pi-bg owns this Run's Orca mailbox: it keeps the only `check --wait` waiter and delivers every batch as an \"Orca delivery\" message. " +
	"Do not run a consuming `orca orchestration check` or orca-wait. Use orca_inbox to see the pending delivery and orca_ack to acknowledge it " +
	"after processing. Read-only `check --peek` / `--all` are allowed. /orca-watch off disables the bridge.";
