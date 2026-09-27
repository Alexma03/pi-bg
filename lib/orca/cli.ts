// Parsing of `orca ... --json` output. Pure: takes the captured stdout,
// stderr and exit status of one CLI invocation and returns a typed outcome.
//
// Verified against Orca 1.4.212: success is `{ok:true, result:{...}}`, failure
// is `{ok:false, error:{code, message}}`. `check --wait` writes `_keepalive`
// JSON lines to stderr every 15s; stdout carries only the final document.

import { parseDelivery, type Delivery } from "./delivery.ts";

export type CliError = {
	kind: "error";
	/** Orca error code, or a pi-bg transport code (`transport`, `spawn`, `parse`). */
	code: string;
	message: string;
	/** Set when Orca applied an --ack before refusing the wait. */
	acknowledged?: string | null;
};

export type CheckOutcome =
	| { kind: "delivery"; delivery: Delivery; acknowledged: string | null }
	| { kind: "empty"; acknowledged: string | null; timedOut: boolean; cancelled: boolean; connectionLost: boolean }
	| CliError;

export type RunCurrentOutcome = { kind: "run"; runId: string | null } | CliError;

export interface CliCapture {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: string | null;
	spawnError?: string;
}

/** Extract the first complete JSON object from CLI stdout. */
export function extractJson(stdout: string): unknown {
	const text = stdout
		.split("\n")
		.filter((line) => !line.includes('"_keepalive"') && !line.includes('"_heartbeat"'))
		.join("\n")
		.trim();
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		// Fall through: tolerate trailing noise after the document.
	}
	const start = text.indexOf("{");
	if (start < 0) return undefined;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) {
				try {
					return JSON.parse(text.slice(start, i + 1));
				} catch {
					return undefined;
				}
			}
		}
	}
	return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function transportError(capture: CliCapture): CliError {
	if (capture.spawnError) return { kind: "error", code: "spawn", message: capture.spawnError };
	const tail = (capture.stderr || capture.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 400);
	const status = capture.signal ? `signal ${capture.signal}` : `exit ${capture.exitCode}`;
	return { kind: "error", code: "transport", message: `orca CLI ${status}${tail ? `: ${tail}` : ""}` };
}

/** Common envelope handling: returns the `result` record or an error. */
function envelope(capture: CliCapture): { result: Record<string, unknown> } | CliError {
	const doc = asRecord(extractJson(capture.stdout));
	if (!doc) return transportError(capture);
	if (doc.ok === false) {
		const error = asRecord(doc.error);
		const code = typeof error?.code === "string" ? error.code : "unknown";
		const message = typeof error?.message === "string" ? error.message : "orca returned ok:false";
		return { kind: "error", code, message };
	}
	if (doc.ok !== true) return { kind: "error", code: "parse", message: "orca output has no ok field" };
	return { result: asRecord(doc.result) ?? {} };
}

export function parseCheckOutput(capture: CliCapture): CheckOutcome {
	const env = envelope(capture);
	if ("kind" in env) return env;
	const result = env.result;
	const acknowledged = typeof result.acknowledged === "string" ? result.acknowledged : null;
	const delivery = parseDelivery(result);
	if (delivery) return { kind: "delivery", delivery, acknowledged };
	// Orca 1.4.212 answers an `--ack X --wait` whose ack applied but whose
	// wait was refused with ok:true and `waitInterrupted`.
	if (typeof result.waitInterrupted === "string" && result.waitInterrupted) {
		return { kind: "error", code: result.waitInterrupted, message: `wait refused after ack (${result.waitInterrupted})`, acknowledged };
	}
	return {
		kind: "empty",
		acknowledged,
		timedOut: result.timedOut === true,
		cancelled: result.cancelled === true,
		connectionLost: result.connectionLost === true,
	};
}

export function parseRunCurrentOutput(capture: CliCapture): RunCurrentOutcome {
	const env = envelope(capture);
	if ("kind" in env) return env;
	const run = asRecord(env.result.run);
	const runId = typeof run?.id === "string" ? run.id : null;
	return { kind: "run", runId };
}

/** Argv for one consuming check. No `--types`: an unfiltered waiter is what
 * suppresses Orca's typed pointer for every message type. */
export function checkArgs(options: { wait: boolean; ack?: string; timeoutMs?: number; runId?: string }): string[] {
	const args = ["orchestration", "check"];
	if (options.runId) args.push("--run", options.runId);
	if (options.ack) args.push("--ack", options.ack);
	if (options.wait) args.push("--wait", "--timeout-ms", String(options.timeoutMs ?? 900_000));
	args.push("--json");
	return args;
}
