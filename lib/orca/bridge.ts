// The Orca bridge driver: runs the effects that machine.ts decides. It owns
// the single waiter child, the retry timer, Run detection and the ack call.

import type { ChildProcess } from "node:child_process";
import { mkdir, writeFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { spawnGroup, terminateGroup, killGroup } from "../spawn.ts";
import { checkArgs, parseCheckOutput, parseRunCurrentOutput, type CheckOutcome, type CliCapture } from "./cli.ts";
import type { Delivery } from "./delivery.ts";
import { initialState, step, type Effect, type OrcaEvent, type OrcaState } from "./machine.ts";
import { runOrcaCli, STDERR_TAIL, STDOUT_CAP } from "./exec.ts";
import { backoffDelay, TRANSPORT_BACKOFF } from "../backoff.ts";

const MAX_FENCE_STREAK = 3;

export interface BridgeDeps {
	orcaBin: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	rawDir: string;
	now: () => number;
	inject: (delivery: Delivery, note: string | undefined, rawPath: string | undefined) => void;
	remind: (delivery: Delivery) => void;
	onChange: () => void;
	log?: (message: string) => void;
	waitTimeoutMs?: number;
	unboundPollMs?: number;
}

export interface AckReply {
	ok: boolean;
	text: string;
	next?: Delivery;
	note?: string;
	rawPath?: string;
}


export class OrcaBridge {
	state: OrcaState = initialState();
	/** User switched the bridge off with /orca-watch off. */
	userOff = false;
	private waiter: { child: ChildProcess; generation: number; ack: string | null } | undefined;
	private generation = 0;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private pollTimer: ReturnType<typeof setTimeout> | undefined;
	private tickTimer: ReturnType<typeof setInterval> | undefined;
	private ackWaiters: Array<(reply: AckReply) => void> = [];
	private disposed = false;
	private detecting = false;
	private detectFailures = 0;
	/** Consecutive consumer fences without a successful wait in between. */
	private fenceStreak = 0;
	private readonly deps: BridgeDeps;

	constructor(deps: BridgeDeps) {
		this.deps = deps;
	}

	start(): void {
		this.tickTimer = setInterval(() => this.dispatch({ type: "tick", now: this.deps.now() }), 30_000);
		this.tickTimer.unref?.();
		void this.detect();
		void pruneOld(this.deps.rawDir, 7 * 24 * 3600_000);
	}

	dispose(): void {
		this.disposed = true;
		if (this.tickTimer) clearInterval(this.tickTimer);
		if (this.pollTimer) clearTimeout(this.pollTimer);
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.killWaiter();
		for (const resolve of this.ackWaiters.splice(0)) resolve({ ok: false, text: "pi-bg is shutting down." });
	}

	/** Synchronous last resort for process exit. */
	killSync(): void {
		if (this.waiter) killGroup(this.waiter.child.pid, "SIGKILL");
	}

	/** Detect the Run bound to this terminal and enable or disable the loop. */
	async detect(): Promise<void> {
		if (this.disposed || this.userOff || this.detecting) return;
		if (this.state.explicitRun && this.state.phase !== "off") return;
		this.detecting = true;
		try {
			const capture = await this.runCli(["orchestration", "run-current", "--json"]);
			if (this.disposed || this.userOff) return;
			const outcome = parseRunCurrentOutput(capture);
			if (outcome.kind === "error") {
				// A transient failure (Orca restarting, CLI timeout) never tears down a
				// live waiter or a pending delivery: keep the phase and retry soon.
				this.detectFailures++;
				this.state = { ...this.state, lastError: `run-current: ${outcome.code}: ${outcome.message}`.slice(0, 300), ...(this.state.phase === "off" ? { reason: `detection failed (${outcome.code}); retrying` } : {}) };
				this.deps.onChange();
				this.detectSoon(backoffDelay(TRANSPORT_BACKOFF, this.detectFailures - 1));
				return;
			}
			this.detectFailures = 0;
			if (outcome.runId) {
				if (this.state.phase === "fenced" && this.state.runId === outcome.runId && this.fenceStreak >= MAX_FENCE_STREAK) {
					// Another terminal keeps taking this Run: stop competing for it.
					this.state = { ...this.state, reason: `fenced ${this.fenceStreak} times on this Run; /orca-watch on to retry` };
					this.deps.onChange();
					return;
				}
				this.dispatch({ type: "enable", runId: outcome.runId, explicit: false });
				return;
			}
			if (this.state.phase !== "off" || this.state.reason !== "no Run bound") this.dispatch({ type: "disable", reason: "no Run bound" });
			this.schedulePoll();
		} finally {
			this.detecting = false;
		}
	}

	private schedulePoll(): void {
		if (this.pollTimer) clearTimeout(this.pollTimer);
		this.pollTimer = setTimeout(() => void this.detect(), this.deps.unboundPollMs ?? 120_000);
		this.pollTimer.unref?.();
	}

	/** Soon after a `run-create` / `run-use` in bash. */
	detectSoon(delayMs = 1_500): void {
		if (this.pollTimer) clearTimeout(this.pollTimer);
		this.pollTimer = setTimeout(() => void this.detect(), delayMs);
		this.pollTimer.unref?.();
	}

	/** `/orca-watch <run>`: consume that Run explicitly with --run. */
	watchRun(runId: string): void {
		this.userOff = false;
		this.dispatch({ type: "enable", runId, explicit: true });
	}

	turnOff(reason = "switched off with /orca-watch off"): void {
		this.userOff = true;
		if (this.pollTimer) clearTimeout(this.pollTimer);
		this.dispatch({ type: "disable", reason });
	}

	turnOn(): void {
		this.userOff = false;
		this.fenceStreak = 0;
		if (this.state.phase === "off" || this.state.phase === "fenced") {
			this.state = { ...this.state, explicitRun: false };
			void this.detect();
		}
	}

	ack(deliveryId: string): Promise<AckReply> {
		return new Promise((resolve) => {
			this.ackWaiters.push(resolve);
			this.dispatch({ type: "ackRequest", deliveryId, now: this.deps.now() });
		});
	}

	dispatch(event: OrcaEvent): void {
		if (this.disposed) return;
		const { state, effects } = step(this.state, event);
		this.state = state;
		for (const effect of effects) this.run(effect);
		this.deps.onChange();
	}

	private run(effect: Effect): void {
		switch (effect.type) {
			case "spawnWait":
				this.spawnWait(effect.ack);
				return;
			case "killWaiter":
				this.killWaiter();
				return;
			case "schedule":
				if (this.retryTimer) clearTimeout(this.retryTimer);
				this.retryTimer = setTimeout(() => this.dispatch({ type: "retry", now: this.deps.now() }), effect.delayMs);
				this.retryTimer.unref?.();
				return;
			case "cancelSchedule":
				if (this.retryTimer) clearTimeout(this.retryTimer);
				this.retryTimer = undefined;
				return;
			case "inject":
				void this.saveRaw(effect.delivery).then((rawPath) => this.deps.inject(effect.delivery, effect.note, rawPath));
				return;
			case "runAck":
				void this.runAck(effect.deliveryId);
				return;
			case "ackReply": {
				const resolve = this.ackWaiters.shift();
				if (!resolve) return;
				if (effect.next) {
					const next = effect.next;
					void this.saveRaw(next).then((rawPath) => resolve({ ok: effect.ok, text: effect.text, next, note: effect.note, rawPath }));
				} else resolve({ ok: effect.ok, text: effect.text });
				return;
			}
			case "redetect":
				this.fenceStreak++;
				this.detectSoon(effect.delayMs * 2 ** Math.min(6, this.fenceStreak - 1));
				return;
			case "remind":
				this.deps.remind(effect.delivery);
				return;
		}
	}

	private spawnWait(ack: string | null): void {
		this.killWaiter();
		const generation = ++this.generation;
		const args = checkArgs({ wait: true, ack: ack ?? undefined, timeoutMs: this.deps.waitTimeoutMs ?? 900_000, runId: this.state.explicitRun ? this.state.runId ?? undefined : undefined });
		let child: ChildProcess;
		try {
			child = spawnGroup([this.deps.orcaBin, ...args], { cwd: this.deps.cwd, env: this.deps.env });
		} catch (error) {
			queueMicrotask(() => this.onWaitClosed(generation, ack, { stdout: "", stderr: "", exitCode: null, signal: null, spawnError: String(error) }));
			return;
		}
		this.waiter = { child, generation, ack };
		collect(child, (capture) => this.onWaitClosed(generation, ack, capture));
	}

	private onWaitClosed(generation: number, ack: string | null, capture: CliCapture): void {
		if (generation !== this.generation || this.disposed) return; // killed or superseded
		this.waiter = undefined;
		const outcome = parseCheckOutput(capture);
		if (outcome.kind === "error") this.deps.log?.(`orca check failed: ${outcome.code}: ${outcome.message}`);
		else this.fenceStreak = 0;
		this.dispatch({ type: "waitResult", outcome, sentAck: ack, now: this.deps.now() });
	}

	private killWaiter(): void {
		const waiter = this.waiter;
		if (!waiter) return;
		this.waiter = undefined;
		this.generation++;
		let closed = false;
		waiter.child.once("close", () => (closed = true));
		terminateGroup(waiter.child.pid, 2_000, () => closed);
	}

	private async runAck(deliveryId: string): Promise<void> {
		const args = checkArgs({ wait: false, ack: deliveryId, runId: this.state.explicitRun ? this.state.runId ?? undefined : undefined });
		const capture = await this.runCli(args);
		const outcome: CheckOutcome = parseCheckOutput(capture);
		this.dispatch({ type: "ackResult", outcome, deliveryId, now: this.deps.now() });
	}

	private runCli(args: string[]): Promise<CliCapture> {
		return runOrcaCli(this.deps.orcaBin, args, { cwd: this.deps.cwd, env: this.deps.env });
	}

	private async saveRaw(delivery: Delivery): Promise<string | undefined> {
		try {
			await mkdir(this.deps.rawDir, { recursive: true, mode: 0o700 });
			const path = join(this.deps.rawDir, `${delivery.id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
			await writeFile(path, JSON.stringify(delivery, null, 2), { mode: 0o600 });
			return path;
		} catch {
			return undefined;
		}
	}
}

function collect(child: ChildProcess, done: (capture: CliCapture) => void): void {
	let stdout = "";
	let stderr = "";
	let spawnError: string | undefined;
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		if (stdout.length < STDOUT_CAP) stdout += chunk;
	});
	child.stderr?.on("data", (chunk: string) => {
		// Keepalive lines arrive every 15 s; keep only a bounded tail.
		stderr = (stderr + chunk).slice(-STDERR_TAIL);
	});
	child.on("error", (error) => (spawnError = error.message));
	child.on("close", (code, signal) => done({ stdout, stderr, exitCode: code, signal, ...(spawnError ? { spawnError } : {}) }));
}

async function pruneOld(dir: string, maxAgeMs: number): Promise<void> {
	try {
		const now = Date.now();
		for (const name of await readdir(dir)) {
			const path = join(dir, name);
			const info = await stat(path);
			if (info.isFile() && now - info.mtimeMs > maxAgeMs) await unlink(path);
		}
	} catch {
		/* best effort */
	}
}

export { pruneOld };
