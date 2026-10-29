import { chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PermissionRules, PermissionRulesError } from "../src/index.ts";

let home: string;
const file = () => join(home, ".atelier", "permissions.json");
const saved = async () => JSON.parse(await readFile(file(), "utf8"));

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "atelier-rules-"));
});

async function writeRules(content: unknown, mode = 0o600) {
	await mkdir(join(home, ".atelier"), { recursive: true });
	await writeFile(file(), typeof content === "string" ? content : JSON.stringify(content));
	await chmod(file(), mode);
}

describe("PermissionRules", () => {
	it("keeps session rules in memory and writes nothing", async () => {
		const rules = new PermissionRules({ home });
		await rules.allow([{ kind: "bash", value: "node" }], "session");
		expect(await rules.current()).toEqual({ bash: ["node"], projectBash: [], paths: [] });
		await expect(stat(file())).rejects.toThrow();
		expect(await new PermissionRules({ home }).current()).toEqual({ bash: [], projectBash: [], paths: [] });
	});

	it("saves always rules to ~/.atelier/permissions.json, 0600, seen by other sessions", async () => {
		const rules = new PermissionRules({ home });
		await rules.allow(
			[
				{ kind: "bash", value: "ego-browser nodejs" },
				{ kind: "path", value: "/Users/ana/notes" },
			],
			"always",
		);
		expect(await saved()).toEqual({
			kind: "atelier.permissions",
			version: 1,
			allow: [{ bash: "ego-browser nodejs" }, { path: "/Users/ana/notes" }],
		});
		expect((await stat(file())).mode & 0o777).toBe(0o600);
		expect(await readdir(join(home, ".atelier"))).toEqual(["permissions.json"]);
		expect(await new PermissionRules({ home }).current()).toEqual({
			bash: ["ego-browser nodejs"],
			projectBash: [],
			paths: ["/Users/ana/notes"],
		});
	});

	it("does not repeat a rule and keeps the rules another session saved meanwhile", async () => {
		const one = new PermissionRules({ home });
		const two = new PermissionRules({ home });
		await Promise.all([
			one.allow([{ kind: "bash", value: "open" }], "always"),
			two.allow([{ kind: "bash", value: "ego-browser nodejs" }], "always"),
		]);
		await one.allow([{ kind: "bash", value: "open" }], "always");
		expect((await saved()).allow).toEqual(expect.arrayContaining([{ bash: "open" }, { bash: "ego-browser nodejs" }]));
		expect((await saved()).allow).toHaveLength(2);
	});

	it("lists session and always rules and removes one", async () => {
		const rules = new PermissionRules({ home });
		await rules.allow([{ kind: "bash", value: "node" }], "session");
		await rules.allow([{ kind: "bash", value: "open" }], "always");
		const listed = await rules.list();
		expect(listed.map(({ scope, kind, value }) => ({ scope, kind, value }))).toEqual([
			{ scope: "session", kind: "bash", value: "node" },
			{ scope: "always", kind: "bash", value: "open" },
		]);
		expect(await rules.remove((listed[1] as { id: string }).id)).toBe(true);
		expect((await saved()).allow).toEqual([]);
		expect(await rules.remove((listed[0] as { id: string }).id)).toBe(true);
		expect(await rules.current()).toEqual({ bash: [], projectBash: [], paths: [] });
		expect(await rules.remove("nothing")).toBe(false);
	});

	it("never allows an interpreter or a launcher always", async () => {
		const rules = new PermissionRules({ home });
		await expect(rules.allow([{ kind: "bash", value: "node" }], "always")).rejects.toThrow(PermissionRulesError);
		await expect(rules.allow([{ kind: "bash", value: "pnpm dlx" }], "always")).rejects.toThrow(PermissionRulesError);
		await expect(stat(file())).rejects.toThrow();
	});

	it("refuses a path rule that is not an absolute folder below the home", async () => {
		const rules = new PermissionRules({ home });
		for (const value of ["notes", "/", home, dirname(home), `${home}/notes/`, `${home}/a/../b`])
			await expect(rules.allow([{ kind: "path", value }], "session")).rejects.toThrow(PermissionRulesError);
	});

	const INVALID: [string, unknown, number, string][] = [
		["not JSON", "{", 0o600, "not valid JSON"],
		["another kind", { kind: "x", version: 1, allow: [] }, 0o600, 'expected kind "atelier.permissions" and version 1'],
		["an unknown key", { kind: "atelier.permissions", version: 1, allow: [], deny: [] }, 0o600, "unknown key"],
		[
			"a bad entry",
			{ kind: "atelier.permissions", version: 1, allow: [{ bash: "open", path: "/x" }] },
			0o600,
			"entry 1",
		],
		["a bad rule", { kind: "atelier.permissions", version: 1, allow: [{ bash: "op*n" }] }, 0o600, "entry 1"],
		["writable by others", { kind: "atelier.permissions", version: 1, allow: [{ bash: "open" }] }, 0o666, "writable"],
	];
	it.each(INVALID)("ignores a file with %s and says why", async (_name, content, mode, reason) => {
		await writeRules(content, mode);
		const rules = new PermissionRules({ home });
		const current = await rules.current();
		expect(current.bash).toEqual([]);
		expect(current.problem).toContain(file());
		expect(current.problem).toContain(reason);
		expect(current.problem).toContain("no saved rule is used");
		// A broken file is never overwritten.
		await expect(rules.allow([{ kind: "bash", value: "open" }], "always")).rejects.toThrow(PermissionRulesError);
	});

	it("without a home keeps session rules only", async () => {
		const rules = new PermissionRules({});
		expect(rules.canSave).toBe(false);
		expect(new PermissionRules({ home }).canSave).toBe(true);
		await rules.allow([{ kind: "bash", value: "open" }], "session");
		expect(await rules.current()).toEqual({ bash: ["open"], projectBash: [], paths: [] });
		await expect(rules.allow([{ kind: "bash", value: "ls" }], "always")).rejects.toThrow(PermissionRulesError);
	});
});
