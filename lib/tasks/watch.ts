// Output watching for background tasks. Pure and clock-agnostic: the caller
// feeds lines with the current time and flushes when told to.
//
//   until  the first matching line produces one notice; the task is then
//          stopped unless keepRunning is set.
//   each   matching lines are coalesced over `coalesceMs` into one notice,
//          at most `maxEvents` notices per task (a wake budget).

export interface WatchSpec {
	pattern: string;
	flags?: string;
	mode?: "until" | "each";
	keepRunning?: boolean;
	maxEvents?: number;
	coalesceMs?: number;
}

export const DEFAULT_MAX_EVENTS = 20;
export const MAX_MAX_EVENTS = 100;
const BATCH_LINES = 20;

export function compileWatch(spec: WatchSpec): RegExp {
	const flags = (spec.flags ?? "").replace(/[gy]/g, "");
	if (!/^[imsuv]*$/.test(flags)) throw new Error(`Unsupported regex flags "${spec.flags}" (allowed: i, m, s, u, v)`);
	if (!spec.pattern) throw new Error("watch.pattern must not be empty");
	return new RegExp(spec.pattern, flags);
}

export class Watcher {
	readonly mode: "until" | "each";
	readonly maxEvents: number;
	readonly coalesceMs: number;
	readonly keepRunning: boolean;
	private readonly regex: RegExp;
	private batch: string[] = [];
	private overflow = 0;
	private batchOpen = false;
	events = 0;
	matched = false;

	constructor(spec: WatchSpec) {
		this.regex = compileWatch(spec);
		this.mode = spec.mode ?? "until";
		this.keepRunning = spec.keepRunning ?? false;
		this.maxEvents = Math.min(MAX_MAX_EVENTS, Math.max(1, spec.maxEvents ?? DEFAULT_MAX_EVENTS));
		this.coalesceMs = Math.max(0, spec.coalesceMs ?? 2_000);
	}

	get exhausted(): boolean {
		return this.mode === "until" ? this.matched : this.events >= this.maxEvents;
	}

	/**
	 * Feed one output line. `notify` asks for an immediate notice (until
	 * mode); `flushAt` asks the caller to call flush() at that time (each).
	 */
	push(line: string, now: number): { notify?: string[]; flushAt?: number } {
		if (this.exhausted) return {};
		if (!this.regex.test(line)) return {};
		this.matched = true;
		if (this.mode === "until") {
			this.events = 1;
			return { notify: [line] };
		}
		if (this.batch.length < BATCH_LINES) this.batch.push(line);
		else this.overflow++;
		if (this.batchOpen) return {};
		this.batchOpen = true;
		return { flushAt: now + this.coalesceMs };
	}

	/** Close the current batch; returns its lines, or undefined if empty. */
	flush(): string[] | undefined {
		this.batchOpen = false;
		if (this.batch.length === 0) return undefined;
		const lines = this.overflow ? [...this.batch, `(+${this.overflow} more matching lines)`] : this.batch;
		this.batch = [];
		this.overflow = 0;
		this.events++;
		return lines;
	}
}

/** Splits a byte stream into lines, bounding the partial line. */
export class LineSplitter {
	private partial = "";
	private readonly maxLine: number;
	constructor(maxLine = 4_096) {
		this.maxLine = maxLine;
	}

	push(chunk: string): string[] {
		const text = this.partial + chunk;
		const parts = text.split("\n");
		this.partial = parts.pop() ?? "";
		if (this.partial.length > this.maxLine) {
			parts.push(this.partial.slice(0, this.maxLine));
			this.partial = "";
		}
		return parts.map((line) => (line.length > this.maxLine ? line.slice(0, this.maxLine) : line).replace(/\r$/, ""));
	}

	end(): string[] {
		const rest = this.partial;
		this.partial = "";
		return rest ? [rest] : [];
	}
}
