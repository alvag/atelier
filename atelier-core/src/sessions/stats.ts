import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { type PhaseSpent, TURN_PHASES, type Usage } from "../events.ts";
import { folderKey, SESSION_KIND, SESSION_VERSION } from "./format.ts";

/** What a group of turns spent. `billedUsd` and `subscriptionUsd` add only known costs; `unpriced` counts the rest. */
export interface StatsSpend {
	turns: number;
	requests: number;
	usage: Usage;
	/** Cost reported by backends paid per use (an API key). */
	billedUsd: number;
	/** What a backend on a subscription reports, as if it were billed: an API-equivalent figure, not a charge. */
	subscriptionUsd: number;
	/** Turns, parts or subagent turns whose backend reported no cost. */
	unpriced: number;
}

export interface StatsRow extends StatsSpend {
	key: string;
}

/** A session file left out, and why. */
export interface SkippedSession {
	path: string;
	code: "corrupt" | "unsupported_version";
	message: string;
}

export interface SessionStats {
	/** Session files with at least one turn in the period. */
	sessions: number;
	total: StatsSpend;
	/** Local days, oldest first. */
	byDay: StatsRow[];
	/** Working directories, models and roles, costliest first. */
	byProject: StatsRow[];
	byModel: StatsRow[];
	/** The parts of a turn in the order they run, then `subagent`. */
	byPhase: StatsRow[];
	byRole: StatsRow[];
	skipped: SkippedSession[];
}

export interface StatsOptions {
	/** Turns that ended before it are left out. */
	since?: Date;
	/** Only this working directory's sessions. */
	project?: string;
	/** Only the saved session with this id; it is looked for in `project`'s folder, so it goes with it. */
	session?: string;
}

/** One part of a turn, ready to be counted under its phase, role and model. */
interface Part {
	phase: string;
	role: string;
	model: string;
	spent: PhaseSpent;
	subscription: boolean;
}

/** A turn the verifier or a review role ran inside a turn: already in its parts, it says which role and model spent what. */
interface RoleTurn {
	role: string;
	model: string;
	spent: PhaseSpent;
	subscription: boolean;
}

/** What a turn or a subagent's turn spent, with its cost when its backend said it. */
interface Spent {
	usage: Usage;
	requests: number;
	cost: Cost;
}

/** One turn of a file: its own totals and its parts, then its subagents' turns, each one part. */
interface Turn {
	day: string;
	ended: number;
	own: Spent;
	parts: Part[];
}

type Cost = { usd: number; subscription: boolean } | undefined;

/**
 * What the saved sessions under `<home>/.atelier/sessions` spent. Read only: each file is streamed line by line, one at a
 * time, and only the lines that can hold a turn's cost or its configuration are parsed.
 */
export async function readSessionStats(home: string, options: StatsOptions = {}): Promise<SessionStats> {
	const root = join(home, ".atelier", "sessions");
	const project = options.project === undefined ? undefined : resolve(options.project);
	const totals = new Totals();
	for (const folder of await namesIn(root)) {
		if (project !== undefined && folder !== folderKey(project)) continue;
		for (const name of await namesIn(join(root, folder))) {
			if (!name.endsWith(".jsonl")) continue;
			if (options.session !== undefined && name !== `${options.session}.jsonl`) continue;
			const path = join(root, folder, name);
			// A file not written since the start of the period holds no turn in it.
			if (options.since !== undefined && (await mtime(path)) < options.since.getTime()) continue;
			const read = await readFile(path);
			if (!read.ok) {
				totals.skipped.push({ path, code: read.code, message: read.message });
				continue;
			}
			if (project !== undefined && read.cwd !== project) continue;
			const turns = read.turns.filter((turn) => options.since === undefined || turn.ended >= options.since.getTime());
			if (turns.length > 0) totals.sessions++;
			for (const turn of turns) totals.add(read.cwd, turn);
		}
	}
	return totals.result();
}

async function namesIn(folder: string): Promise<string[]> {
	try {
		return (await readdir(folder)).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR")
			return [];
		throw error;
	}
}

async function mtime(path: string): Promise<number> {
	return (await stat(path)).mtimeMs;
}

type FileRead = { ok: true; cwd: string; turns: Turn[] } | { ok: false; code: SkippedSession["code"]; message: string };

/** A line worth parsing: the header, a configuration, or an event that says who runs or what a turn spent. */
const WANTED = /^\{"type":"config"|"type":"turn_finished"|"type":"session_started"/;

async function readFile(path: string): Promise<FileRead> {
	const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
	let number = 0;
	let cwd = "";
	let createdAt = 0;
	let backend = "";
	let model: string | undefined;
	const auth = new Map<string, string>();
	const turns: Turn[] = [];
	let subagents: Part[] = [];
	let roleTurns: RoleTurn[] = [];
	// A line that is not JSON is a crash's torn end only when nothing follows it and the file does not end with a newline.
	let unreadable: number | undefined;
	for await (const line of lines) {
		number++;
		if (unreadable !== undefined) break;
		if (number > 1 && !WANTED.test(line)) continue;
		let value: Record<string, unknown>;
		try {
			value = JSON.parse(line);
		} catch {
			unreadable = number;
			continue;
		}
		if (number === 1) {
			if (value?.kind !== SESSION_KIND)
				return { ok: false, code: "corrupt", message: `the first line is not an ${SESSION_KIND} header` };
			if (value.version !== SESSION_VERSION)
				return {
					ok: false,
					code: "unsupported_version",
					message: `it was saved with session format version ${String(value.version)}`,
				};
			createdAt = typeof value.createdAt === "string" ? Date.parse(value.createdAt) : Number.NaN;
			if (typeof value.cwd !== "string" || Number.isNaN(createdAt))
				return { ok: false, code: "corrupt", message: "the header lacks a working directory or a creation time" };
			cwd = value.cwd;
			continue;
		}
		if (value.type === "config") {
			backend = String(value.backend);
			model = typeof value.model === "string" ? value.model : undefined;
			continue;
		}
		const event = value.event as Record<string, unknown> | undefined;
		if (value.type !== "event" || typeof event !== "object" || event === null) continue;
		if (event.type === "session_started") {
			auth.set(String(event.backend), String(event.authSource));
			continue;
		}
		if (event.type !== "turn_finished") continue;
		const tag = typeof event.agent === "string" ? event.agent : undefined;
		const fallback = { backend, model: model ?? (backend === "" ? "unknown" : `${backend} default`), auth };
		// The verifier's and the review's turns are already parts of the turn that ran them: they only split those parts.
		if (tag?.startsWith("verify:") || tag?.startsWith("review:")) {
			const [first] = partsOf(event, fallback);
			roleTurns.push({
				role: tag.startsWith("verify:") ? tag.slice("verify:".length) : `review-${tag.slice("review:".length)}`,
				model: first?.model ?? fallback.model,
				spent: phaseOf(event),
				subscription: first?.subscription ?? false,
			});
			continue;
		}
		const spent = turnSpent(event, fallback);
		if (tag !== undefined) {
			// A subagent's turn is not in its parent's totals: it is counted apart, with the parent's turn.
			const [first] = partsOf(event, fallback);
			subagents.push({
				...(first ?? emptyPart()),
				phase: "subagent",
				role: tag,
				spent: phaseOf(event),
				subscription: spent.cost?.subscription ?? false,
			});
			continue;
		}
		const ended =
			typeof event.at === "string" && !Number.isNaN(Date.parse(event.at)) ? Date.parse(event.at) : createdAt;
		const parts = splitMixed(partsOf(event, fallback), roleTurns);
		turns.push({ ended, day: localDay(ended), own: spent, parts: [...parts, ...subagents] });
		subagents = [];
		roleTurns = [];
	}
	if (number === 0) return { ok: false, code: "corrupt", message: "the file is empty" };
	if (unreadable !== undefined && (unreadable < number || (await endsWithNewline(path))))
		return { ok: false, code: "corrupt", message: `line ${unreadable} is not valid JSON` };
	if (unreadable === 1)
		return { ok: false, code: "corrupt", message: `the first line is not an ${SESSION_KIND} header` };
	return { ok: true, cwd, turns };
}

async function endsWithNewline(path: string): Promise<boolean> {
	const file = await open(path, "r");
	try {
		const { size } = await file.stat();
		const last = Buffer.alloc(1);
		await file.read(last, 0, 1, size - 1);
		return last.toString() === "\n";
	} finally {
		await file.close();
	}
}

interface Fallback {
	backend: string;
	model: string;
	auth: Map<string, string>;
}

function turnSpent(event: Record<string, unknown>, fallback: Fallback): Spent {
	const parts = partsOf(event, fallback);
	const own = phaseOf(event);
	// The turn is on a subscription when every part with a cost is, or, when no part says its cost, when its backend is.
	const priced = parts.filter((part) => part.spent.costUsd !== undefined);
	const subscription =
		priced.length > 0
			? priced.every((part) => part.subscription)
			: fallback.auth.get(parts[0]?.spent.agents?.[0]?.backend ?? fallback.backend) === "subscription";
	return {
		usage: own.usage,
		requests: own.requests ?? 0,
		cost: own.costUsd === undefined ? undefined : { usd: own.costUsd, subscription },
	};
}

/** The turn's parts; a turn saved before `phases` existed is one `main` part. */
function partsOf(event: Record<string, unknown>, fallback: Fallback): Part[] {
	const phases = (event.phases ?? { main: phaseOf(event) }) as Record<string, PhaseSpent | undefined>;
	return TURN_PHASES.flatMap((phase) => {
		const spent = phases[phase];
		if (spent === undefined) return [];
		const agents = spent.agents ?? [];
		const backend = agents[0]?.backend ?? fallback.backend;
		return [
			{
				phase,
				role: one(
					agents.map((agent) => agent.role),
					// The main part is always the main agent's.
					phase === "main" ? "orchestrator" : "unknown",
				),
				model: one(
					agents.map((agent) => agent.model),
					fallback.model,
				),
				spent,
				subscription: fallback.auth.get(backend) === "subscription",
			},
		];
	});
}

/** The one value, `none` without any, or `mixed` when they differ. */
function one(values: string[], none: string): string {
	const distinct = [...new Set(values)];
	return distinct.length === 0 ? none : distinct.length === 1 ? (distinct[0] ?? none) : "mixed";
}

/**
 * A part where several models or roles ran, split by the turns its roles left in the file (the verifier, each lens);
 * what they do not explain goes to the part's other agents, and stays `mixed` when those still differ.
 */
function splitMixed(parts: Part[], roleTurns: RoleTurn[]): Part[] {
	const left = [...roleTurns];
	return parts.flatMap((part) => {
		if (part.model !== "mixed" && part.role !== "mixed") return [part];
		const agents = part.spent.agents ?? [];
		const own = left.filter((turn) => agents.some((agent) => agent.role === turn.role));
		if (own.length === 0) return [part];
		for (const turn of own) left.splice(left.indexOf(turn), 1);
		const split: Part[] = own.map(({ role, model, spent, subscription }) => ({
			phase: part.phase,
			role,
			model,
			spent,
			subscription,
		}));
		const rest = agents.filter((agent) => !own.some((turn) => turn.role === agent.role));
		const remainder = subtract(
			part.spent,
			own.map((turn) => turn.spent),
		);
		if (remainder === undefined) return split;
		return [
			...split,
			{
				phase: part.phase,
				role: one(
					rest.map((agent) => agent.role),
					"mixed",
				),
				model: one(
					rest.map((agent) => agent.model),
					"mixed",
				),
				spent: remainder,
				subscription: part.subscription,
			},
		];
	});
}

/** What `total` spent beyond `parts`, or undefined when that is nothing. */
function subtract(total: PhaseSpent, parts: PhaseSpent[]): PhaseSpent | undefined {
	const sum = (pick: (spent: PhaseSpent) => number) => parts.reduce((all, spent) => all + pick(spent), 0);
	const usage: Usage = {
		input: Math.max(0, total.usage.input - sum((spent) => spent.usage.input)),
		output: Math.max(0, total.usage.output - sum((spent) => spent.usage.output)),
		cacheRead: Math.max(0, total.usage.cacheRead - sum((spent) => spent.usage.cacheRead)),
		cacheWrite: Math.max(0, total.usage.cacheWrite - sum((spent) => spent.usage.cacheWrite)),
	};
	const requests =
		total.requests === undefined ? undefined : Math.max(0, total.requests - sum((spent) => spent.requests ?? 0));
	const costKnown = total.costUsd !== undefined && parts.every((spent) => spent.costUsd !== undefined);
	const costUsd = costKnown ? Math.max(0, (total.costUsd ?? 0) - sum((spent) => spent.costUsd ?? 0)) : undefined;
	// Rounding leaves a few billionths of a dollar behind; that is not a cost.
	const nothing =
		usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0 &&
		(requests ?? 0) === 0 &&
		(costUsd ?? 0) < 1e-9;
	if (nothing) return undefined;
	return {
		usage,
		...(requests === undefined ? {} : { requests }),
		...(costUsd === undefined ? {} : { costUsd }),
	};
}

function phaseOf(event: Record<string, unknown>): PhaseSpent {
	return {
		usage: { ...zero(), ...(event.usage as Partial<Usage> | undefined) },
		...(typeof event.requests === "number" ? { requests: event.requests } : {}),
		...(typeof event.costUsd === "number" ? { costUsd: event.costUsd } : {}),
	};
}

function emptyPart(): Part {
	return { phase: "subagent", role: "unknown", model: "unknown", spent: { usage: zero() }, subscription: false };
}

const zero = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function addUsage(a: Usage, b: Usage): Usage {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
	};
}

/** The day in the local time zone, as `YYYY-MM-DD`. */
function localDay(time: number): string {
	const date = new Date(time);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The running sums: one row per key, so memory grows with days, projects, models and roles, not with turns. */
class Totals {
	sessions = 0;
	readonly skipped: SkippedSession[] = [];
	readonly #total = emptySpend();
	readonly #groups = {
		day: new Map<string, StatsSpend>(),
		project: new Map<string, StatsSpend>(),
		model: new Map<string, StatsSpend>(),
		phase: new Map<string, StatsSpend>(),
		role: new Map<string, StatsSpend>(),
	};

	add(cwd: string, turn: Turn): void {
		const whole = [this.#total, row(this.#groups.day, turn.day), row(this.#groups.project, cwd)];
		for (const target of whole) count(target, turn.own);
		// A turn counts once in each row it ran in, however many of its parts are there.
		const seen = new Set<StatsSpend>(whole);
		for (const part of turn.parts) {
			const spent = {
				usage: part.spent.usage,
				requests: part.spent.requests ?? 0,
				cost:
					part.spent.costUsd === undefined ? undefined : { usd: part.spent.costUsd, subscription: part.subscription },
			};
			// A subagent's turn is not in its parent's totals: it adds to them.
			if (part.phase === "subagent") for (const target of whole) count(target, spent, false);
			for (const [group, key] of [
				[this.#groups.model, part.model],
				[this.#groups.phase, part.phase],
				[this.#groups.role, part.role],
			] as const) {
				const target = row(group, key);
				count(target, spent, !seen.has(target));
				seen.add(target);
			}
		}
	}

	result(): SessionStats {
		const phaseOrder: string[] = [...TURN_PHASES, "subagent"];
		const rows = (group: Map<string, StatsSpend>) => [...group].map(([key, spend]) => ({ key, ...spend }));
		const costliest = (a: StatsRow, b: StatsRow) =>
			b.billedUsd + b.subscriptionUsd - (a.billedUsd + a.subscriptionUsd) || a.key.localeCompare(b.key);
		return {
			sessions: this.sessions,
			total: this.#total,
			byDay: rows(this.#groups.day).sort((a, b) => a.key.localeCompare(b.key)),
			byProject: rows(this.#groups.project).sort(costliest),
			byModel: rows(this.#groups.model).sort(costliest),
			byPhase: rows(this.#groups.phase).sort((a, b) => phaseOrder.indexOf(a.key) - phaseOrder.indexOf(b.key)),
			byRole: rows(this.#groups.role).sort(costliest),
			skipped: this.skipped,
		};
	}
}

function emptySpend(): StatsSpend {
	return { turns: 0, requests: 0, usage: zero(), billedUsd: 0, subscriptionUsd: 0, unpriced: 0 };
}

function row(group: Map<string, StatsSpend>, key: string): StatsSpend {
	const known = group.get(key);
	if (known !== undefined) return known;
	const spend = emptySpend();
	group.set(key, spend);
	return spend;
}

function count(target: StatsSpend, spent: Spent, newTurn = true): void {
	if (newTurn) target.turns++;
	target.requests += spent.requests;
	target.usage = addUsage(target.usage, spent.usage);
	if (spent.cost === undefined) target.unpriced++;
	else if (spent.cost.subscription) target.subscriptionUsd += spent.cost.usd;
	else target.billedUsd += spent.cost.usd;
}
