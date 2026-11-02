import { execFileSync } from "node:child_process";
import { appendFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realpathAllowMissing } from "../src/tools/paths.ts";
import { projectRefusal } from "../src/tools/protection.ts";

let base: string;
let cwd: string;
let home: string;

beforeEach(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), "git-config-parser-")));
	cwd = join(base, "repo");
	home = join(base, "home");
	execFileSync("git", ["init", "-q", cwd]);
});

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

/** Ends the repository's config with `text` and a broken header, so git rejects it and the fallback parser answers. */
const brokenConfig = (text: string) => appendFile(join(cwd, ".git", "config"), `${text}[invalid\n`);

async function refusals(paths: string[]) {
	return Promise.all(
		paths.map(async (path) => projectRefusal("write", cwd, path, await realpathAllowMissing(path), home)),
	);
}

const refused = (path: string) => `${path} is git state that runs code: the agent does not write it.`;

describe("a git config git rejects is read with git's value syntax", () => {
	it("keeps a # or ; inside quotes and drops a trailing comment, for include, includeIf and hooksPath", async () => {
		await brokenConfig(
			[
				"[include]",
				'\tpath = "../team#cfg"',
				'\tpath = "../team;cfg" ; trailing comment',
				'\tpath = "../a\\"b#c.cfg" # comment',
				"\tpath = ../plain.cfg # comment",
				'\tpath = "../con\\',
				'tinued#cfg"',
				'[includeIf "gitdir:/never/"]',
				'\tpath = "../cond;cfg"',
				"[core]",
				'\thooksPath = "hooks#dir"',
				"",
			].join("\n"),
		);
		const protectedPaths = [
			"team#cfg",
			"team;cfg",
			'a"b#c.cfg',
			"plain.cfg",
			"continued#cfg",
			"cond;cfg",
			join("hooks#dir", "pre-commit"),
		].map((path) => join(cwd, path));
		expect(await refusals(protectedPaths)).toEqual(protectedPaths.map(refused));
		expect(await refusals([join(cwd, "ordinary.cfg")])).toEqual([undefined]);
	});

	it("protects every reading of an entry it can only read tolerantly: an open quote and an unknown escape", async () => {
		await brokenConfig(
			["[include]", '\tpath = "../open#quote', "\tpath = ../esc\\qape.cfg", "[core]", '\thooksPath = "hk;dir', ""].join(
				"\n",
			),
		);
		const gitDir = join(cwd, ".git");
		const protectedPaths = [
			// To the end of the line and cut at the comment, without and with the quote.
			join(cwd, "open#quote"),
			join(cwd, "open"),
			join(gitDir, '"..', "open#quote"),
			join(gitDir, '"..', "open"),
			// The escape read as its letter and as written.
			join(cwd, "escqape.cfg"),
			join(cwd, "esc\\qape.cfg"),
			// A hooks path is relative to the repository's top.
			...["hk;dir", '"hk;dir', "hk", '"hk'].map((dir) => join(cwd, dir, "pre-commit")),
		];
		expect(await refusals(protectedPaths)).toEqual(protectedPaths.map(refused));
		expect(await refusals([join(cwd, "ordinary.cfg")])).toEqual([undefined]);
	});
});
