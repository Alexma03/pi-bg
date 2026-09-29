// Compact, screen-only view used by `orca_screen`. Keep answerable prompts;
// discard terminal chrome and spinner/status churn first.

import { sanitizeTerminal } from "../text.ts";

const CONTEXT = /\b\d+(?:\.\d+)?%\/\d+(?:\.\d+)?[kM]\b/;

export function trimWorkerScreen(tail: string[], maxLines = 30): string[] {
	const useful: string[] = [];
	for (const raw of tail) {
		let line = sanitizeTerminal(raw).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();
		if (!line) continue;
		if (/^─{2,}.*(?:Working|Thinking|Tool|Waiting).*─{2,}$/i.test(line)) continue;
		if (/^─{4,}$/.test(line) || /^╰/.test(line)) continue;
		if (/^╭─/.test(line)) {
			const title = line.replace(/^╭─\s*/, "").replace(/─+╮?$/, "").trim();
			if (title) useful.push(title);
			continue;
		}
		if (CONTEXT.test(line) || /^orca\s+(?:◉|◆|⚠)/i.test(line) || /^⏵\s+\d+\s+(?:tarea|task)/i.test(line)) continue;
		line = line.replace(/^\s*[│║]\s?/, "").replace(/\s*[│║]\s*$/, "").trim();
		if (!line || /^─{3,}$/.test(line)) continue;
		if (/^(?:[✔✖■])\s/.test(line)) continue;
		useful.push(line);
	}
	const count = Math.max(1, Math.min(200, Math.floor(maxLines) || 30));
	return useful.slice(-count);
}
