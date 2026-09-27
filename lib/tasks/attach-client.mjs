#!/usr/bin/env node
// Attach client: the foreground half of an attached pi-bg task. The bash tool
// runs this instead of the command itself; the command runs as a pi-bg task.
// It copies the task's output from its log to stdout and exits with the
// task's exit code. When pi-bg detaches the task (for example because an
// Orca coordinator message arrived), it returns at once and the command keeps
// running in the background.
//
// usage: attach-client.mjs <logPath> <outputOffset> <taskId>
// The task ends by writing `<logPath>.ctl`: {"state":"exit","code","signal"} or {"state":"detached"}.

import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { constants } from "node:os";

const [logPath, offsetArg, taskId] = process.argv.slice(2);
const ctl = `${logPath}.ctl`;
let position = Number(offsetArg) || 0;
const buffer = Buffer.alloc(64 * 1024);

function drain() {
	let fd;
	try {
		fd = openSync(logPath, "r");
	} catch {
		return;
	}
	try {
		for (;;) {
			const n = readSync(fd, buffer, 0, buffer.length, position);
			if (n <= 0) break;
			position += n;
			process.stdout.write(buffer.subarray(0, n));
		}
	} finally {
		closeSync(fd);
	}
}

function readCtl() {
	if (!existsSync(ctl)) return undefined;
	try {
		return JSON.parse(readFileSync(ctl, "utf8"));
	} catch {
		return undefined;
	}
}

function tick() {
	drain();
	const state = readCtl();
	if (!state) return;
	clearInterval(timer);
	drain();
	if (state.state === "detached") {
		const why =
			state.reason === "slow"
				? `[pi-bg] The command is still running after ${Math.round((state.afterMs ?? 0) / 1000)}s, so it moved to the background as ${taskId}; do not wait for it or poll it.\n` +
					`[pi-bg] Keep working or end the turn: its pi-bg notice arrives when it ends. Next time, start commands this slow with bg_run.\n`
				: `[pi-bg] Moved to the background as ${taskId} so you can read a new message; the command is still running.\n` +
					`[pi-bg] Its pi-bg notice arrives when it ends.\n`;
		process.stdout.write(`\n${why}[pi-bg] bg_tail {id: "${taskId}"} shows its output; bg_cancel stops it.\n`);
		process.exit(0);
	}
	if (state.error) process.stderr.write(`${state.error}\n`);
	const code = typeof state.code === "number" ? state.code : state.signal ? 128 + (constants.signals[state.signal] ?? 0) : 1;
	process.exit(code);
}

const timer = setInterval(tick, 100);
tick();
// Killed by the bash tool (timeout or abort): pi-bg cancels the task itself.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => process.exit(128 + (constants.signals[signal] ?? 0)));
