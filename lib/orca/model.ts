// Evidence-based model display for Orca's fleet card. The coordinator's own
// session model is never a worker model: launch metadata and that worker's
// terminal status are stronger evidence than a Pi profile default.

export interface ModelChoice {
	provider?: string;
	model: string;
	thinking?: string;
	source: "launch" | "status" | "default";
}

export interface ModelParts {
	provider?: string;
	model: string;
	thinking?: string;
}

export interface PiProfileSettings {
	defaultProvider?: unknown;
	defaultModel?: unknown;
	defaultThinkingLevel?: unknown;
	modelThinkingLevels?: unknown;
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function splitQualified(model: string, provider?: string): ModelParts {
	const slash = model.indexOf("/");
	if (slash > 0) return { provider: model.slice(0, slash), model: model.slice(slash + 1) };
	return { ...(provider ? { provider } : {}), model };
}

function choice(parts: ModelParts, source: ModelChoice["source"]): ModelChoice | undefined {
	const qualified = splitQualified(parts.model, parts.provider);
	if (!qualified.model) return undefined;
	return {
		...(qualified.provider ? { provider: qualified.provider } : {}),
		model: qualified.model,
		...(parts.thinking ? { thinking: parts.thinking } : {}),
		source,
	};
}

/** The Pi settings shape used by the profile fallback. */
export function profileModel(settings: PiProfileSettings): ModelChoice | undefined {
	const model = text(settings.defaultModel);
	if (!model) return undefined;
	const provider = text(settings.defaultProvider);
	const parts = splitQualified(model, provider);
	const perModel = settings.modelThinkingLevels && typeof settings.modelThinkingLevels === "object" && !Array.isArray(settings.modelThinkingLevels)
		? (settings.modelThinkingLevels as Record<string, unknown>)
		: {};
	const thinking = text(perModel[`${parts.provider ? `${parts.provider}/` : ""}${parts.model}`]) || text(perModel[parts.model]) || text(settings.defaultThinkingLevel);
	return choice({ ...parts, ...(thinking ? { thinking } : {}) }, "default");
}

/** Parse only the Pi footer status line, not arbitrary model-like terminal text. */
export function parsePiStatusModel(tail: string[]): ModelChoice | undefined {
	for (let i = tail.length - 1; i >= 0; i--) {
		const line = tail[i];
		if (!/\b\d+(?:\.\d+)?%\/\d+(?:\.\d+)?[kM]\b/.test(line)) continue;
		const match = /\(([^()]+)\)\s+([^\s•·]+)(?:\s*[•·]\s*([\w-]+))?\s*$/.exec(line);
		if (!match) continue;
		const parsed = choice({ provider: match[1].trim(), model: match[2].trim(), ...(match[3] ? { thinking: match[3] } : {}) }, "status");
		if (parsed) return parsed;
	}
	return undefined;
}

/** Pick the strongest worker-specific evidence, and never guess a reused terminal's default. */
export function resolveWorkerModel(input: {
	launch?: ModelParts;
	status?: ModelParts;
	profile?: ModelParts;
	reusedTerminal?: boolean;
}): ModelChoice | undefined {
	const launched = input.launch && choice(input.launch, "launch");
	if (launched) return launched;
	const status = input.status && choice(input.status, "status");
	if (status) return status;
	if (input.reusedTerminal) return undefined;
	return input.profile && choice(input.profile, "default");
}

/** Render provider/model plus the thinking level when evidence includes it. */
export function formatModel(model: ModelChoice | undefined): string {
	if (!model) return "";
	const name = model.provider && !model.model.includes("/") ? `${model.provider}/${model.model}` : model.model;
	return `${name}${model.thinking ? ` · ${model.thinking}` : ""}`;
}
