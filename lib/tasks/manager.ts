// Background task registry: spawns commands in their own process groups,
// streams output to a log file, keeps a small in-memory tail, runs watches
// and deadlines, and reports settled tasks through `onNotice`.
//
// Lifetime rule (user decision): tasks never outlive the Pi runtime that
// started them. shutdown() runs on every session_shutdown (quit, reload,
// new, resume, fork); killAllSync() is the process-exit fallback; the spawn
// wrapper's watchdog covers a Pi crash.

import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { redact } from "../redact.ts";
import { clip, formatDuration, lastLines, sanitizeTerminal } from "../text.ts";
import { killGroup, spawnShell, terminateGroup } from "../spawn.ts";
import { LineSplitter, Watcher, type WatchSpec } from "./watch.ts";
import type { TaskNotice } from "./notice.ts";

export type TaskStatus = "running" | "exited" | "failed" | "cancelled" | "timeout" | "matched";

export interface TaskSpec {
	command: string;
	cwd: string;
	label?: string;
	/** Deadline; undefined means none. */
	timeoutMs?: number;
	watch?: WatchSpec;
	/**
	 * A foreground command followed by an attach client (the bash tool): no
	 * notice while attached; its end is written to `<log>.ctl` for the client.
	 * `detach()` turns it into an ordinary background task.
	 */
	attached?: boolean;
}

export interface TaskSnapshot {
	id: string;
	label: string;
	command: string;
	cwd: string;
	pid: number | undefined;
	status: TaskStatus;
	startedAt: number;
	endedAt: number | undefined;
	exitCode: number | null;
	signal: string | null;
	logPath: string;
	bytes: number;
	watch: WatchSpec | undefined;
	watchEvents: number;
	/** Set when the log file could not be opened or written. */
	logError?: string;
	/** Still followed by a foreground attach client (see TaskSpec.attached). */
	attached?: boolean;
	/** Deadline after which the group is stopped, if any. */
	timeoutMs?: number;
	/** Byte offset in the log where the command's output starts (after the header). */
	outputOffset: number;
}

export interface ManagerDeps {
	logDir: string;
	now: () => number;
	onNotice: (notice: TaskNotice) => void;
	onChange?: () => void;
	/** Task started / ended, e.g. to tell Orca that child work is live. */
	onLifecycle?: (id: string, phase: "started" | "ended") => void;
	env?: NodeJS.ProcessEnv;
	maxRunning?: number;
	logMaxBytes?: number;
	tailChars?: number;
	noticeLines?: number;
	killGraceMs?: number;
	/** Finished tasks kept for bg_status / bg_tail (default 200). */
	maxFinished?: number;
}

interface Task {
	snap: TaskSnapshot;
	child: ChildProcess;
	log: WriteStream;
	tail: string;
	splitter: LineSplitter;
	watcher: Watcher | undefined;
	quiet: boolean;
	timedOut: boolean;
	logCapped: boolean;
	timers: Set<ReturnType<typeof setTimeout>>;
	done: boolean;
}

export class TaskManager {
	private readonly tasks = new Map<string, Task>();
	private counter = 0;
	private starting = 0;
	private readonly stamp: string;
	private readonly deps: ManagerDeps;

	constructor(deps: ManagerDeps) {
		this.deps = deps;
		this.stamp = new Date(deps.now()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
	}

	private get maxRunning(): number {
		return this.deps.maxRunning ?? 16;
	}

	running(): TaskSnapshot[] {
		return this.list().filter((t) => t.status === "running");
	}

	list(): TaskSnapshot[] {
		return [...this.tasks.values()].map((t) => ({ ...t.snap }));
	}

	get(id: string): TaskSnapshot | undefined {
		const task = this.tasks.get(id);
		return task ? { ...task.snap } : undefined;
	}

	async start(spec: TaskSpec): Promise<TaskSnapshot> {
		if (!spec.command.trim()) throw new Error("command must not be empty");
		// Reserve the slot before awaiting, so parallel bg_run calls cannot all pass the limit.
		if (this.running().length + this.starting >= this.maxRunning) throw new Error(`Too many running background tasks (${this.maxRunning}); cancel one first.`);
		this.starting++;
		try {
			return await this.launch(spec);
		} finally {
			this.starting--;
		}
	}

	private async launch(spec: TaskSpec): Promise<TaskSnapshot> {
		const watcher = spec.watch ? new Watcher(spec.watch) : undefined;
		await mkdir(this.deps.logDir, { recursive: true, mode: 0o700 });
		const id = `bg${++this.counter}`;
		const logPath = join(this.deps.logDir, `${this.stamp}-${id}.log`);
		const log = createWriteStream(logPath, { flags: "w", mode: 0o600 });
		// Without a listener a failed open or write would crash Pi.
		log.on("error", (error) => {
			const task = this.tasks.get(id);
			if (task && !task.snap.logError) {
				task.snap.logError = clip(error.message, 200);
				this.changed();
			}
		});
		const startedAt = this.deps.now();
		const header = `# pi-bg ${id} · started ${new Date(startedAt).toISOString()} · cwd ${spec.cwd}\n# $ ${spec.command}\n`;
		log.write(header);
		const child = spawnShell(spec.command, { cwd: spec.cwd, env: { ...(this.deps.env ?? process.env), PI_BG_TASK_ID: id } });
		const task: Task = {
			snap: {
				id,
				label: spec.label?.trim() || id,
				command: spec.command,
				cwd: spec.cwd,
				pid: child.pid,
				status: "running",
				startedAt,
				endedAt: undefined,
				exitCode: null,
				signal: null,
				logPath,
				bytes: 0,
				watch: spec.watch,
				watchEvents: 0,
				outputOffset: Buffer.byteLength(header),
				...(spec.attached ? { attached: true } : {}),
				...(spec.timeoutMs && spec.timeoutMs > 0 ? { timeoutMs: spec.timeoutMs } : {}),
			},
			child,
			log,
			tail: "",
			splitter: new LineSplitter(),
			watcher,
			quiet: false,
			timedOut: false,
			logCapped: false,
			timers: new Set(),
			done: false,
		};
		this.tasks.set(id, task);
		this.deps.onLifecycle?.(id, "started");
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => this.onOutput(task, chunk));
		child.stderr?.on("data", (chunk: string) => this.onOutput(task, chunk));
		child.on("error", (error) => this.onSpawnError(task, error));
		child.on("close", (code, signal) => this.onClose(task, code, signal));
		if (spec.timeoutMs && spec.timeoutMs > 0) {
			this.timer(task, spec.timeoutMs, () => {
				if (task.done) return;
				task.timedOut = true;
				terminateGroup(task.snap.pid, this.deps.killGraceMs ?? 3_000, () => task.done);
			});
		}
		this.changed();
		return { ...task.snap };
	}

	private timer(task: Task, ms: number, fn: () => void): void {
		const handle = setTimeout(() => {
			task.timers.delete(handle);
			fn();
		}, ms);
		handle.unref?.();
		task.timers.add(handle);
	}

	private onOutput(task: Task, chunk: string): void {
		task.snap.bytes += Buffer.byteLength(chunk);
		const cap = this.deps.logMaxBytes ?? 64 * 1024 * 1024;
		if (task.snap.logError) {
			// The stream is dead; keep the in-memory tail only.
		} else if (task.snap.bytes <= cap) task.log.write(chunk);
		else if (!task.logCapped) {
			task.logCapped = true;
			task.log.write(`\n[pi-bg: log reached ${cap} bytes; further output is not written]\n`);
		}
		const tailChars = this.deps.tailChars ?? 32_768;
		task.tail = (task.tail + chunk).slice(-tailChars);
		if (!task.watcher) return;
		for (const line of task.splitter.push(chunk)) this.onLine(task, line);
	}

	private onLine(task: Task, line: string): void {
		const watcher = task.watcher;
		if (!watcher || task.done) return;
		const now = this.deps.now();
		const result = watcher.push(sanitizeTerminal(line), now);
		if (result.notify) {
			task.snap.watchEvents = watcher.events;
			const stop = !watcher.keepRunning;
			this.emit(task, "match", result.notify, { stillRunning: !stop, stopped: stop });
			if (stop) {
				task.quiet = true;
				task.snap.status = "matched";
				terminateGroup(task.snap.pid, this.deps.killGraceMs ?? 3_000, () => task.done);
			}
		} else if (result.flushAt !== undefined) {
			this.timer(task, Math.max(0, result.flushAt - now), () => this.flushWatch(task, true));
		}
	}

	private flushWatch(task: Task, stillRunning: boolean): void {
		const watcher = task.watcher;
		if (!watcher) return;
		const lines = watcher.flush();
		if (!lines) return;
		task.snap.watchEvents = watcher.events;
		const note = watcher.exhausted ? `watch budget of ${watcher.maxEvents} notices reached; further matches are silent, the exit will still be reported.` : undefined;
		this.emit(task, "match", lines, { stillRunning, note });
	}

	private emit(task: Task, kind: TaskNotice["kind"], lines: string[], extra: { stillRunning: boolean; stopped?: boolean; note?: string }): void {
		const watcher = task.watcher;
		this.deps.onNotice({
			kind,
			id: task.snap.id,
			label: task.snap.label,
			command: task.snap.command,
			logPath: task.snap.logPath,
			durationMs: (task.snap.endedAt ?? this.deps.now()) - task.snap.startedAt,
			exitCode: task.snap.exitCode,
			signal: task.snap.signal,
			lines,
			stillRunning: extra.stillRunning,
			...(extra.stopped ? { stopped: true } : {}),
			...(extra.note ? { note: extra.note } : {}),
			...(watcher ? { pattern: task.snap.watch?.pattern, eventNumber: watcher.events, maxEvents: watcher.mode === "each" ? watcher.maxEvents : 1 } : {}),
		});
	}

	private onSpawnError(task: Task, error: Error): void {
		if (task.done) return;
		this.finish(task);
		task.snap.status = "failed";
		if (task.snap.attached) void writeCtl(task.snap.logPath, { state: "exit", code: 127, signal: null, error: clip(error.message, 400) });
		else if (!task.quiet) this.emit(task, "error", [clip(error.message, 400)], { stillRunning: false });
		this.changed();
	}

	private onClose(task: Task, code: number | null, signal: NodeJS.Signals | null): void {
		if (task.done) return;
		for (const line of task.splitter.end()) this.onLine(task, line);
		if (task.watcher && task.watcher.mode === "each" && !task.quiet) this.flushWatch(task, false);
		this.finish(task);
		task.snap.exitCode = code;
		task.snap.signal = signal;
		if (task.snap.status === "running") {
			task.snap.status = task.timedOut ? "timeout" : task.quiet ? "cancelled" : "exited";
		}
		if (task.snap.attached) {
			// The foreground client prints this, so the model knows why its command died.
			const error = task.timedOut ? `pi-bg: stopped at its ${formatDuration(task.snap.timeoutMs ?? 0)} deadline. If the command needs longer, run it again with a larger bash timeout (seconds).` : undefined;
			const end = { state: "exit", code, signal, ...(error ? { error } : {}) };
			if (task.snap.logError) void writeCtl(task.snap.logPath, end);
			else task.log.once("close", () => void writeCtl(task.snap.logPath, end));
		} else if (!task.quiet) {
			// Redact before splitting so multiline secrets (PEM blocks) match.
			const lines = lastLines(redact(sanitizeTerminal(task.tail)), this.deps.noticeLines ?? 15);
			const notes = [
				task.watcher && task.watcher.mode === "until" && !task.watcher.matched ? `watch pattern /${task.snap.watch?.pattern}/ never matched.` : "",
				task.snap.logError ? `log file could not be written (${task.snap.logError}); output shown is from memory only.` : "",
			].filter(Boolean);
			const note = notes.length ? notes.join(" ") : undefined;
			this.emit(task, task.timedOut ? "timeout" : "exit", lines, { stillRunning: false, ...(note ? { note } : {}) });
		}
		// The tail only serves the exit notice; bg_tail reads the log file. Keep a
		// small one when the log is unusable, and bound the finished history.
		task.tail = task.snap.logError ? task.tail.slice(-4_096) : "";
		this.pruneFinished();
		this.changed();
	}

	private pruneFinished(): void {
		const max = this.deps.maxFinished ?? 200;
		const finished = [...this.tasks.values()].filter((t) => t.done);
		for (const t of finished.slice(0, Math.max(0, finished.length - max))) this.tasks.delete(t.snap.id);
	}

	private finish(task: Task): void {
		task.done = true;
		this.deps.onLifecycle?.(task.snap.id, "ended");
		task.snap.endedAt = this.deps.now();
		for (const t of task.timers) clearTimeout(t);
		task.timers.clear();
		task.log.end();
	}

	private changed(): void {
		this.deps.onChange?.();
	}

	/** Last non-empty output line of a running task, sanitized and redacted. */
	lastLine(id: string): string | undefined {
		const task = this.tasks.get(id);
		if (!task || task.done) return undefined;
		const lines = redact(sanitizeTerminal(task.tail.slice(-2_000))).split("\n").filter((l) => l.trim());
		const last = lines.at(-1);
		return last === undefined ? undefined : clip(last.trim(), 120);
	}

	/**
	 * Let an attached task keep running in the background: its attach client
	 * returns now, and the ordinary exit notice follows when it ends.
	 */
	detach(id: string, reason: "mail" | "slow" = "mail", afterMs?: number): TaskSnapshot | undefined {
		const task = this.tasks.get(id);
		if (!task || task.done || !task.snap.attached) return undefined;
		task.snap.attached = false;
		void writeCtl(task.snap.logPath, { state: "detached", id, reason, ...(afterMs !== undefined ? { afterMs } : {}) });
		this.changed();
		return { ...task.snap };
	}

	/** Stop a running task. No notice is sent; the caller reports it. */
	cancel(id: string): boolean {
		const task = this.tasks.get(id);
		if (!task || task.done) return false;
		task.quiet = true;
		task.snap.status = "cancelled";
		terminateGroup(task.snap.pid, this.deps.killGraceMs ?? 3_000, () => task.done);
		this.changed();
		return true;
	}

	/** Bounded, sanitized, redacted tail of a task log. */
	async tail(id: string, options: { lines?: number; grep?: string } = {}): Promise<string> {
		const task = this.tasks.get(id);
		if (!task) throw new Error(`Unknown task ${id}`);
		const wanted = Math.min(400, Math.max(1, options.lines ?? 40));
		const text = task.snap.logError ? task.tail : await readTailBytes(task.snap.logPath, 256 * 1024);
		// Redact the whole text before splitting so multiline secrets (PEM blocks) match.
		let lines = redact(sanitizeTerminal(text)).replace(/\n$/, "").split("\n");
		if (options.grep) {
			const regex = new RegExp(options.grep, "i");
			lines = lines.filter((line) => regex.test(line));
		}
		return clip(lines.slice(-wanted).join("\n"), 20_000);
	}

	/** Kill every running task: TERM, wait up to graceMs, then KILL. */
	async shutdown(graceMs = 1_500): Promise<void> {
		const live = [...this.tasks.values()].filter((t) => !t.done);
		for (const task of live) {
			task.quiet = true;
			killGroup(task.snap.pid, "SIGTERM");
		}
		const deadline = Date.now() + graceMs;
		while (live.some((t) => !t.done) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
		for (const task of live) if (!task.done) killGroup(task.snap.pid, "SIGKILL");
	}

	/** Synchronous last resort for process exit. */
	killAllSync(): void {
		for (const task of this.tasks.values()) {
			if (task.done) continue;
			task.quiet = true;
			killGroup(task.snap.pid, "SIGKILL");
		}
	}
}

async function readTailBytes(path: string, maxBytes: number): Promise<string> {
	const handle = await open(path, "r");
	try {
		const { size } = await handle.stat();
		const start = Math.max(0, size - maxBytes);
		const buffer = Buffer.alloc(size - start);
		await handle.read(buffer, 0, buffer.length, start);
		const text = buffer.toString("utf8");
		// Drop a partial first line when we started mid-file.
		return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
	} finally {
		await handle.close();
	}
}

/** Control file read by the attach client (lib/tasks/attach-client.mjs). */
export function ctlPath(logPath: string): string {
	return `${logPath}.ctl`;
}

async function writeCtl(logPath: string, data: Record<string, unknown>): Promise<void> {
	try {
		const path = ctlPath(logPath);
		await writeFile(`${path}.tmp`, JSON.stringify(data), { mode: 0o600 });
		await rename(`${path}.tmp`, path);
	} catch {
		/* the client falls back to its own checks */
	}
}
