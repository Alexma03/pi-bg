// Classifies shell commands the model runs through the bash tool, so the
// bridge can (a) block a second mailbox consumer and (b) notice Run binding
// changes. Heuristic by design: it splits on shell separators and inspects
// each simple command, ignoring heredoc bodies and quoted strings; quoting
// tricks can evade it, which only costs the protection, never correctness of
// the bridge itself.

export type OrcaCommandKind = "consuming-check" | "peek-check" | "bind" | "worker-start" | "worker-done" | "escalation" | "ask" | "other";

const SEPARATORS = /\|\||&&|[;|&\n]|\$\(|`/;

/**
 * Drop text the shell never runs as a command: heredoc bodies and quoted
 * strings (a script or test that merely mentions `orca orchestration check`).
 * A quoted string after `-c` (`bash -lc`), `env -S` or `eval` is still code, so it is kept.
 */
export function stripInert(command: string): string {
	const out: string[] = [];
	const terminators: string[] = [];
	for (const line of command.split("\n")) {
		if (terminators.length) {
			if (line.replace(/^\t+/, "").trim() === terminators[0]) terminators.shift();
			continue;
		}
		for (const m of line.matchAll(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g)) terminators.push(m[2]);
		out.push(line);
	}
	return out
		.join("\n")
		.replace(/(^|[^\\])(['"])((?:\\.|(?!\2)[^\\])*)\2/g, (whole, before: string, quote: string, body: string, offset: number, all: string) => {
			const lead = all.slice(Math.max(0, offset - 16), offset + before.length);
			return /(^|\s)(-[a-z]*c|-S|--split-string|eval)\s*$/.test(lead) || !/\s/.test(body) ? whole : `${before}${quote}${quote}`;
		});
}

function segments(command: string): string[] {
	return stripInert(command)
		.split(SEPARATORS)
		.map((s) => s.trim())
		.filter(Boolean);
}

// Words that run the command after them.
const WRAPPERS = new Set(["env", "command", "exec", "nohup", "time", "timeout", "nice", "setsid", "stdbuf", "sudo", "doas", "python", "python3", "bash", "sh", "zsh", "fish"]);

/**
 * True when a segment runs orca-wait itself, not a command that only looks
 * at it (`which`, `cat`, `head`…). Behind a wrapper it fails closed: wrapper
 * options can take values (`timeout -s KILL 60`, `sudo -u x`, `env -S '…'`),
 * so any orca-wait after one counts.
 */
function runsOrcaWait(segment: string): boolean {
	const tokens = segment.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, "")).filter(Boolean);
	const isOrcaWait = (t: string) => (t.split("/").pop() ?? "") === "orca-wait";
	let i = 0;
	while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
	const first = tokens[i];
	if (first === undefined) return false;
	if (isOrcaWait(first)) return true;
	if (!WRAPPERS.has(first.split("/").pop() ?? "")) return false;
	// `command -v` / `-V` only locate the program.
	if (first === "command" && /^-[vV]$/.test(tokens[i + 1] ?? "")) return false;
	return tokens.slice(i + 1).some(isOrcaWait);
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
		if (runsOrcaWait(segment)) {
			kinds.push("consuming-check");
			continue;
		}
		const rest = orcaSubcommand(segment);
		if (!rest) continue;
		const [group, verb] = rest.filter((t) => !t.startsWith("-"));
		if (group !== "orchestration") continue;
		if (verb === "check") {
			// --ack mutates the mailbox even alongside --peek / --all.
			// `--help` / `-h` only prints usage and never reaches the mailbox.
			const help = rest.some((t) => t === "--help" || t === "-h");
			const readOnly = help || ((rest.includes("--peek") || rest.includes("--all")) && !rest.some((t) => t === "--ack" || t.startsWith("--ack=")));
			kinds.push(readOnly ? "peek-check" : "consuming-check");
		} else if (verb === "run-create" || verb === "run-use") {
			kinds.push("bind");
		} else if (verb === "worker-start") {
			kinds.push("worker-start");
		} else if (verb === "ask") {
			kinds.push("ask");
		} else if (verb === "send") {
			const type = rest[rest.indexOf("--type") + 1];
			if (rest.includes("--type") && type === "worker_done") kinds.push("worker-done");
			else if (rest.includes("--type") && type === "escalation") kinds.push("escalation");
		}
	}
	return kinds.length ? kinds : ["other"];
}

export const BLOCK_REASON =
	"pi-bg owns this Run's Orca mailbox: it keeps the only `check --wait` waiter and delivers every batch as an \"Orca delivery\" message. " +
	"Do not run a consuming `orca orchestration check` or orca-wait. Use orca_inbox to see the pending delivery and orca_ack to acknowledge it " +
	"after processing. Read-only `check --peek` / `--all` are allowed. /orca-watch off disables the bridge.";
