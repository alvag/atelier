import { readFile } from "node:fs/promises";
import { gitText, runGit } from "./git.ts";

/** A prefix of this worktree's HEAD reflog, captured before the turn's tools can run. */
export interface TurnReflog {
	path: string;
	text: string;
}

export type TurnBase = { ok: true; commit?: string; note?: string } | { ok: false; reason: string };
type Entry = { from: string; to: string; message: string };
const OWN_COMMIT = /^commit( \((initial|amend)\))?: /;

export async function captureTurnReflog(cwd: string): Promise<TurnReflog | null> {
	try {
		const logging = await runGit(["config", "--type=bool", "--get", "core.logAllRefUpdates"], { cwd });
		if (logging.code === 0 && logging.stdout.toString("utf8").trim() === "false") return null;
		if (logging.code !== 0 && logging.code !== 1) {
			// `always` is valid for reflogs, but is not a git boolean.
			if ((await gitText(["config", "--get", "core.logAllRefUpdates"], { cwd })).trim() !== "always") return null;
		}
		// In a linked worktree this is its gitdir, not the repository's common gitdir.
		const path = (await gitText(["rev-parse", "--path-format=absolute", "--git-path", "logs/HEAD"], { cwd })).trimEnd();
		return { path, text: await readFile(path, "utf8") };
	} catch {
		return null;
	}
}

function unavailable(detail: string): TurnBase {
	return { ok: false, reason: `Cannot safely attribute the turn's rewritten commits: ${detail}.` };
}

const REPLAY_FAILED = "the rebase replay cannot be attributed unambiguously";

async function signatures(cwd: string, shas: readonly string[]): Promise<string[] | null> {
	const out: string[] = [];
	for (const sha of shas) {
		const args = ["diff-tree", "--root", "--no-commit-id", "--no-renames", "--no-ext-diff", "--no-textconv"];
		const result = await runGit([...args, "--binary", "--unified=0", "-p", sha], { cwd });
		if (result.code !== 0) return null;
		out.push(result.stdout.toString("latin1").replace(/^index [0-9a-f]+\.\.[0-9a-f]+/gm, "index"));
	}
	return out;
}

/** Linear chains as `[sha, parent]`, or null when any commit is a root or merge. */
async function chain(cwd: string, args: readonly string[]): Promise<[string, string][] | null> {
	const result = await runGit(["rev-list", "--parents", ...args], { cwd });
	if (result.code !== 0) return null;
	const rows = result.stdout
		.toString("utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split(" "));
	return rows.every((row) => row.length === 2) ? rows.map((row) => [row[0] ?? "", row[1] ?? ""]) : null;
}

/**
 * Attributes one complete linear rebase. `boundary` is the rewritten pre-turn boundary
 * (undefined for a rebase without own commits), and `owned` has its rebased ids replaced.
 */
async function attributeRebase(
	cwd: string,
	start: string,
	entries: readonly Entry[],
	owned: string[],
): Promise<{ boundary?: string | undefined; landed: string } | null> {
	const first = entries[0];
	const finish = entries[entries.length - 1];
	if (first === undefined || finish === undefined || !finish.message.startsWith("rebase (finish): returning to "))
		return null;
	const replays = entries.slice(1, -1).map((entry) => entry.to);
	const landed = replays[replays.length - 1] ?? first.to;
	if (finish.from !== landed || finish.to !== landed) return null;
	const originals = await chain(cwd, ["--reverse", `${first.to}..${first.from}`]);
	const ownIndexes = (originals ?? []).flatMap(([sha], i) => (owned.includes(sha) ? [i] : []));
	if (originals === null || originals.length !== replays.length) return null;
	if (ownIndexes.length === 0) return { landed };
	const firstOwn = ownIndexes[0] ?? 0;
	if (ownIndexes.length !== originals.length - firstOwn) return null;
	if ((await runGit(["merge-base", "--is-ancestor", start, first.from], { cwd })).code !== 0) return null;
	const replayed = await chain(cwd, ["--no-walk=unsorted", ...replays]);
	if (replayed === null || replayed.some(([, parent], i) => parent !== (i === 0 ? first.to : replays[i - 1])))
		return null;
	if (originals.some(([, parent], i) => i > 0 && parent !== originals[i - 1]?.[0])) return null;
	const before = await signatures(
		cwd,
		originals.map(([sha]) => sha),
	);
	const after = await signatures(cwd, replays);
	if (before === null || after === null || new Set(before).size !== before.length) return null;
	if (before.some((sig, i) => sig === "" || sig !== after[i])) return null;
	for (const i of ownIndexes) owned[owned.indexOf(originals[i]?.[0] ?? "")] = replays[i] ?? "";
	return { boundary: firstOwn === 0 ? first.to : replays[firstOwn - 1], landed };
}

/** Only the non-ancestor path: normal descendants retain the existing turn-start rule. */
export async function rewrittenTurnBase(
	cwd: string,
	start: string,
	head: string,
	boundary: TurnReflog | null,
): Promise<TurnBase> {
	const current = await captureTurnReflog(cwd);
	if (boundary === null || current === null) return unavailable("the worktree's HEAD reflog is unavailable");
	if (current.path !== boundary.path || !current.text.startsWith(boundary.text))
		return unavailable("the worktree's HEAD reflog no longer contains the turn-start boundary");
	const entries: Entry[] = [];
	for (const line of current.text.slice(boundary.text.length).split("\n").filter(Boolean)) {
		const match = /^([0-9a-f]+) ([0-9a-f]+) [^\t]*\t(.*)$/.exec(line);
		if (match === null || !match[3]) return unavailable("a HEAD reflog entry has no operation message");
		entries.push({ from: match[1] ?? "", to: match[2] ?? "", message: match[3] });
	}
	let tip = start;
	for (const entry of entries) {
		if (entry.from !== tip) return unavailable("the HEAD reflog transitions are incomplete");
		tip = entry.to;
	}
	if (tip !== head) return unavailable("the HEAD reflog transitions are incomplete");
	let base = start;
	let resetBase: string | undefined;
	let moved: "switch" | "landing" | "replay" | undefined;
	let rewritten = false;
	const owned: string[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry === undefined) return unavailable("the HEAD reflog transitions are incomplete");
		if (entry.message.startsWith("rebase (start): ")) {
			let end = i + 1;
			while (entries[end]?.message.startsWith("rebase (pick): ")) end++;
			const rebase = await attributeRebase(cwd, base, entries.slice(i, end + 1), owned);
			if (rebase === null) return unavailable(REPLAY_FAILED);
			resetBase = undefined;
			rewritten = rebase.boundary !== undefined;
			moved = rewritten ? "replay" : "landing";
			base = rebase.boundary ?? rebase.landed;
			i = end;
		} else if (OWN_COMMIT.test(entry.message)) {
			if (resetBase !== undefined) base = resetBase;
			resetBase = undefined;
			rewritten = true;
			owned.push(entry.to);
		} else if (entry.message.startsWith("checkout: ")) {
			owned.length = 0;
			base = entry.to;
			resetBase = undefined;
			moved = "switch";
			rewritten = false;
		} else if (entry.message.startsWith("reset: ")) {
			const before = resetBase ?? base;
			const ancestor = await runGit(["merge-base", "--is-ancestor", entry.to, before], { cwd });
			if (ancestor.code !== 0) return unavailable("a HEAD reflog operation is not attributable");
			resetBase = before;
			base = entry.to;
			rewritten = false;
		} else return unavailable("a HEAD reflog operation is not attributable");
	}
	const prefix = `HEAD no longer descends from ${start.slice(0, 7)}, where the turn started: `;
	if (moved === "landing" || moved === "replay") {
		const where = moved === "landing" ? "where HEAD landed after the rebase" : "before the turn's replayed commits";
		return {
			ok: true,
			commit: base,
			note: `${prefix}the base moved to ${base.slice(0, 7)}, ${where}, to exclude upstream history`,
		};
	}
	if (moved === "switch")
		return {
			ok: true,
			commit: base,
			note: `${prefix}the base moved to ${base.slice(0, 7)}, where HEAD landed after the branch switch, to exclude that branch's history`,
		};
	if (rewritten)
		return {
			ok: true,
			commit: base,
			note: `${prefix}the base remains the turn-start tree because the turn rewrote its commits`,
		};
	return { ok: true, commit: head, note: `${prefix}the base is the current HEAD` };
}
