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
	let switched = false;
	let rewritten = false;
	for (const entry of entries) {
		if (OWN_COMMIT.test(entry.message)) {
			if (resetBase !== undefined) base = resetBase;
			resetBase = undefined;
			rewritten = true;
		} else if (entry.message.startsWith("checkout: ")) {
			base = entry.to;
			resetBase = undefined;
			switched = true;
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
	if (switched)
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
