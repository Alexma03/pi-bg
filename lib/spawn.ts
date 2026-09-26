// Process-group spawning with a parent-death watchdog.
//
// Every child pi-bg starts (background tasks and the Orca waiter) runs inside
// a small bash wrapper that is the leader of its own process group. The
// wrapper forks a watchdog that polls the Pi process; if Pi dies without a
// clean shutdown (SIGKILL, crash), the watchdog terminates the whole group
// within ~2 s. A clean shutdown kills the group directly with killGroup().
// This matters most for the Orca waiter: an orphaned `check --wait` would keep
// holding the Run's exclusive waiter slot.
//
// When the wrapped command exits, the wrapper also TERMs whatever it left in
// the group (e.g. `cmd &` with redirected output) and a detached reaper KILLs
// leftovers that ignore TERM, so nothing outlives its task (user decision).
// The wrapper ignores that TERM itself and exits with the command's status.

import { spawn, type ChildProcess } from "node:child_process";

const WRAPPER = [
	'parent="$PI_BG_PARENT_PID"',
	'( while kill -0 "$parent" 2>/dev/null; do sleep 2; done; kill -TERM 0 2>/dev/null; sleep 3; kill -KILL 0 2>/dev/null ) </dev/null >/dev/null 2>&1 &',
	"watchdog=$!",
	'"$@"',
	"status=$?",
	'kill "$watchdog" 2>/dev/null',
	"trap '' TERM",
	"kill -TERM 0 2>/dev/null",
	'( sleep 1; kill -KILL 0 2>/dev/null ) </dev/null >/dev/null 2>&1 &',
	'exit "$status"',
].join("\n");

export interface SpawnOptions {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	/** Pid the watchdog follows; defaults to this process. */
	parentPid?: number;
}

/** Run `argv` in a new process group under the watchdog wrapper. */
export function spawnGroup(argv: string[], options: SpawnOptions): ChildProcess {
	if (argv.length === 0) throw new Error("spawnGroup: empty argv");
	return spawn("bash", ["-c", WRAPPER, "pi-bg", ...argv], {
		cwd: options.cwd,
		env: { ...(options.env ?? process.env), PI_BG_PARENT_PID: String(options.parentPid ?? process.pid) },
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/** Run a shell command line (bash -c) in a new process group. */
export function spawnShell(command: string, options: SpawnOptions): ChildProcess {
	return spawnGroup(["bash", "-c", command], options);
}

/** Signal a whole process group. Returns false when it no longer exists. */
export function killGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
	if (!pid) return false;
	try {
		process.kill(-pid, signal);
		return true;
	} catch {
		return false;
	}
}

/** TERM the group, then KILL it after `graceMs` unless `isDone()` holds. */
export function terminateGroup(pid: number | undefined, graceMs: number, isDone: () => boolean): void {
	if (!killGroup(pid, "SIGTERM")) return;
	const timer = setTimeout(() => {
		if (!isDone()) killGroup(pid, "SIGKILL");
	}, graceMs);
	timer.unref?.();
}
