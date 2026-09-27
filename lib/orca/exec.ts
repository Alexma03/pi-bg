// One short-lived `orca` CLI call with bounded output. Used for read-only
// calls (run-current, worker-list, task-list) and the synchronous ack; the
// long `check --wait` waiter runs under the spawn watchdog instead.

import { execFile } from "node:child_process";
import type { CliCapture } from "./cli.ts";

export const STDOUT_CAP = 4 * 1024 * 1024;
export const STDERR_TAIL = 8 * 1024;
export const CLI_TIMEOUT_MS = 20_000;

export function runOrcaCli(bin: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<CliCapture> {
	return new Promise((resolve) => {
		execFile(bin, args, { cwd: options.cwd, env: options.env, timeout: options.timeoutMs ?? CLI_TIMEOUT_MS, maxBuffer: STDOUT_CAP }, (error, stdout, stderr) => {
			const err = error as (NodeJS.ErrnoException & { code?: string | number; signal?: string }) | null;
			if (err && err.code === "ENOENT") {
				resolve({ stdout: "", stderr: "", exitCode: null, signal: null, spawnError: `${bin} not found on PATH` });
				return;
			}
			resolve({
				stdout: String(stdout ?? ""),
				stderr: String(stderr ?? "").slice(-STDERR_TAIL),
				exitCode: err ? (typeof err.code === "number" ? err.code : 1) : 0,
				signal: err?.signal ?? null,
			});
		});
	});
}
