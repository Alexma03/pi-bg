// Best-effort credential redaction for text that pi-bg forwards to the model
// or renders in the terminal. The raw log file on disk is left untouched (it
// is the user's own output, mode 0600); only what we copy out of it passes
// through here. Patterns favour false positives over leaks.

const REDACTED = "[REDACTED]";

const PATTERNS: Array<[RegExp, string | ((...groups: string[]) => string)]> = [
	// PEM private keys and certificates with key material.
	[/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, `-----BEGIN PRIVATE KEY----- ${REDACTED}`],
	// Orphaned PEM body whose BEGIN line fell outside a tail window: the whole
	// run of base64-only lines ending at an END line, including the short last
	// line the long-run fallback below would miss. The lookbehind starts the
	// match only at the first line of a run, keeping the scan linear.
	[
		/(?<!^[ \t]*[A-Za-z0-9+/=]+[ \t]*\r?\n)^(?:[ \t]*[A-Za-z0-9+/=]+[ \t]*\r?\n)*[ \t]*-----END [A-Z0-9 ]*PRIVATE KEY-----/gm,
		`${REDACTED} -----END PRIVATE KEY-----`,
	],
	// Authorization headers and bearer tokens.
	[/\b(authorization\s*[:=]\s*)(?:bearer|basic|token)?\s*[^\s"',;]+/gi, (_m, prefix) => `${prefix}${REDACTED}`],
	[/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
	// JSON Web Tokens.
	[/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED],
	// Well-known token prefixes.
	[/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, REDACTED],
	[/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED],
	[/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g, REDACTED],
	[/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, REDACTED],
	[/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
	[/\bglpat-[A-Za-z0-9_-]{16,}\b/g, REDACTED],
	[/\bnpm_[A-Za-z0-9]{30,}\b/g, REDACTED],
	// Credentials embedded in URLs: scheme://user:secret@host
	[/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, (_m, prefix) => `${prefix}${REDACTED}@`],
	// key=value / key: value assignments whose key names a secret.
	[
		/\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_.-]*)(\s*[:=]\s*|"\s*:\s*")("?)([^\s"',;&]{4,})/gi,
		(_m, key, sep, quote) => `${key}${sep}${quote}${REDACTED}`,
	],
	// Fallback: long base64-looking runs, e.g. PEM body lines whose BEGIN line
	// fell outside a tail window. Requiring upper, lower and a digit spares hex
	// digests (git SHAs) and plain words or paths.
	[/(?<![A-Za-z0-9+/=])(?=[A-Za-z0-9+/=]*[A-Z])(?=[A-Za-z0-9+/=]*[a-z])(?=[A-Za-z0-9+/=]*[0-9])[A-Za-z0-9+/=]{40,}/g, REDACTED],
];

export function redact(text: string): string {
	let out = text;
	for (const [pattern, replacement] of PATTERNS) {
		out = out.replace(pattern, replacement as never);
	}
	return out;
}
