import type { Candidate, ChangedFile, Manifest } from "./candidate.ts";
import { isDocumentationPath, contentSignals as signalsIn } from "./signals.ts";

export const LENSES = ["risk", "resilience", "readability", "reliability"] as const;
export type Lens = (typeof LENSES)[number];
export type RiskLevel = "passive" | "medium" | "high";

/** The high-risk items the agent can name: 1 data, 2 security, 3 contracts, 4 concurrency, 5 delivery, 6 no test would catch it. */
export interface Escalation {
	items: number[];
	reason: string;
}

export interface RiskOptions {
	escalations?: readonly Escalation[];
	/** The lens for a medium-risk review; ignored at other levels. */
	lens?: Lens;
}

export interface Assessment {
	level: RiskLevel;
	/** Why, in order: each signal names the file or the agent's reason. */
	reasons: string[];
	lenses: Lens[];
	files: string[];
	changedLines: number;
	/** Only high risk is reviewed without being asked for. */
	reviewDue: boolean;
	empty: boolean;
}

const PATH_WORDS = [
	"auth",
	"security",
	"permission",
	"payment",
	"webhook",
	"migration",
	"secret",
	"credential",
] as const;
const LOCKFILES = new Set([
	"pnpm-lock.yaml",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"yarn.lock",
	"bun.lock",
	"bun.lockb",
	"Cargo.lock",
	"go.sum",
	"poetry.lock",
	"uv.lock",
	"Gemfile.lock",
	"composer.lock",
]);
const ENVIRONMENT = [
	/(^|\/)Dockerfile[^/]*$/,
	/(^|\/)(docker-)?compose[^/]*\.ya?ml$/,
	/(^|\/)\.github\/workflows\//,
	/(^|\/)\.gitlab-ci\.yml$/,
];
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"] as const;

/**
 * Derives the risk of a frozen candidate from its diff alone. The model, the
 * size of the change and the number of files are not inputs; the agent can
 * only raise the level, with a reason.
 */
export function assessRisk(candidate: Candidate, options: RiskOptions = {}): Assessment {
	const files = candidate.files.map((file) => file.path).sort();
	const base = { files, changedLines: candidate.changedLines };
	if (candidate.files.length === 0)
		return { ...base, level: "passive", reasons: ["no changes"], lenses: [], reviewDue: false, empty: true };

	const signals = [
		...fileSignals(candidate.files),
		...contentSignals(candidate),
		...manifestSignals(candidate.manifests),
	];
	for (const escalation of options.escalations ?? []) {
		const items = escalation.items.join(", ");
		signals.push(`agent: ${escalation.items.length === 1 ? "item" : "items"} ${items} (${escalation.reason})`);
	}
	if (signals.length > 0)
		return { ...base, level: "high", reasons: signals, lenses: [...LENSES], reviewDue: true, empty: false };
	if (isPassive(candidate))
		return { ...base, level: "passive", reasons: ["documentation only"], lenses: [], reviewDue: false, empty: false };
	return {
		...base,
		level: "medium",
		reasons: ["code change without a high-risk signal"],
		lenses: [options.lens ?? "reliability"],
		reviewDue: false,
		empty: false,
	};
}

/** Documentation only: Markdown or text files (or documentation under docs/), plain mode, no code fences. */
function isPassive(candidate: Candidate): boolean {
	return (
		candidate.fencedDocs.length === 0 &&
		candidate.files.every(
			(file) => !file.binary && (file.status === "D" || file.mode === "100644") && isDocumentationPath(file.path),
		)
	);
}

function fileSignals(files: readonly ChangedFile[]): string[] {
	const signals: string[] = [];
	for (const file of files) {
		const name = file.path.split("/").pop() ?? file.path;
		if (LOCKFILES.has(name)) signals.push(`lockfile: ${file.path}`);
		else if (ENVIRONMENT.some((pattern) => pattern.test(file.path))) signals.push(`environment: ${file.path}`);
		else {
			const lower = file.path.toLowerCase();
			const word = PATH_WORDS.find((candidate) => lower.includes(candidate));
			if (word !== undefined) signals.push(`path: ${file.path} (${word})`);
		}
	}
	return signals;
}

function contentSignals(candidate: Candidate): string[] {
	const found = new Set<string>();
	for (const line of candidate.signalLines)
		for (const label of signalsIn(line.text)) found.add(`content: ${line.path} adds ${label}`);
	return [...found];
}

function manifestSignals(manifests: readonly Manifest[]): string[] {
	const signals: string[] = [];
	for (const manifest of manifests) {
		const before = parseManifest(manifest.before);
		const after = parseManifest(manifest.after);
		if (before === undefined || after === undefined) {
			signals.push(`dependencies: ${manifest.path} (unreadable)`);
			continue;
		}
		for (const field of DEPENDENCY_FIELDS)
			if (!sameJson(before[field], after[field])) signals.push(`dependencies: ${manifest.path} (${field})`);
		const scripts = (value: Record<string, unknown>) => (value.scripts ?? {}) as Record<string, unknown>;
		for (const script of INSTALL_SCRIPTS)
			if (!sameJson(scripts(before)[script], scripts(after)[script]))
				signals.push(`dependencies: ${manifest.path} (scripts.${script})`);
	}
	return signals;
}

/** A missing side counts as an empty manifest; text that does not parse as an object is undefined. */
function parseManifest(text: string | undefined): Record<string, unknown> | undefined {
	if (text === undefined) return {};
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
