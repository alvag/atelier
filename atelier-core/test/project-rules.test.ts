import { chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PermissionRules, PermissionRulesError } from "../src/index.ts";

let home: string;
let app: string;
let other: string;
const globalFile = () => join(home, ".atelier", "permissions.json");
const projectFile = () => join(home, ".atelier", "project-permissions.json");
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));

beforeEach(async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "atelier-project-rules-")));
	home = join(root, "home");
	app = join(root, "code", "app");
	other = join(root, "code", "clone");
	await mkdir(join(app, ".git"), { recursive: true });
	await mkdir(join(app, "packages", "web"), { recursive: true });
	await mkdir(join(other, ".git"), { recursive: true });
	await mkdir(home, { recursive: true });
});

async function writeJson(path: string, content: unknown) {
	await mkdir(join(home, ".atelier"), { recursive: true });
	await writeFile(path, JSON.stringify(content));
	await chmod(path, 0o600);
}

describe("rules allowed always in a project", () => {
	it("are saved in ~/.atelier/project-permissions.json with the project's real path, never in permissions.json", async () => {
		const rules = new PermissionRules({ home, cwd: join(app, "packages", "web") });
		expect(await rules.project()).toBe(app);
		await rules.allow([{ kind: "bash", value: "pnpm install" }], "project");
		expect(await json(projectFile())).toEqual({
			kind: "atelier.project-permissions",
			version: 1,
			allow: [{ bash: "pnpm install", project: app }],
		});
		expect((await stat(projectFile())).mode & 0o777).toBe(0o600);
		await expect(stat(globalFile())).rejects.toThrow();
		expect(await rules.current()).toEqual({ bash: [], projectBash: ["pnpm install"], paths: [] });
	});

	it("apply only in sessions of that project", async () => {
		await new PermissionRules({ home, cwd: app }).allow([{ kind: "bash", value: "pnpm install" }], "project");
		expect((await new PermissionRules({ home, cwd: join(app, "packages") }).current()).projectBash).toEqual([
			"pnpm install",
		]);
		expect((await new PermissionRules({ home, cwd: other }).current()).projectBash).toEqual([]);
	});

	it("never allow a project's command in every folder", async () => {
		const rules = new PermissionRules({ home, cwd: app });
		await expect(rules.allow([{ kind: "bash", value: "npm install" }], "always")).rejects.toThrow(
			/runs code the project defines: it is allowed always only in a project/,
		);
		await expect(rules.allow([{ kind: "bash", value: "node" }], "project")).rejects.toThrow(PermissionRulesError);
		await expect(rules.allow([{ kind: "path", value: join(home, "x") }], "project")).rejects.toThrow(
			PermissionRulesError,
		);
		await expect(stat(globalFile())).rejects.toThrow();
		await expect(stat(projectFile())).rejects.toThrow();
	});

	it("cannot be saved without a working directory", async () => {
		await expect(new PermissionRules({ home }).allow([{ kind: "bash", value: "make" }], "project")).rejects.toThrow(
			"this session has no project to save the rule for",
		);
	});

	it("are listed with their project and removed", async () => {
		const rules = new PermissionRules({ home, cwd: app });
		await rules.allow([{ kind: "bash", value: "make" }], "project");
		await new PermissionRules({ home, cwd: other }).allow([{ kind: "bash", value: "make" }], "project");
		const listed = await rules.list();
		expect(listed).toEqual([{ id: "project:bash:make", scope: "project", kind: "bash", value: "make", project: app }]);
		expect(await rules.remove("project:bash:make")).toBe(true);
		expect((await json(projectFile())).allow).toEqual([{ bash: "make", project: other }]);
		expect(await rules.remove("project:bash:make")).toBe(false);
	});

	it("ignore a broken project file whole and keep the other rules", async () => {
		await writeJson(globalFile(), { kind: "atelier.permissions", version: 1, allow: [{ bash: "open" }] });
		await writeJson(projectFile(), { kind: "atelier.project-permissions", version: 1, allow: [{ bash: "make" }] });
		const current = await new PermissionRules({ home, cwd: app }).current();
		expect(current.bash).toEqual(["open"]);
		expect(current.projectBash).toEqual([]);
		expect(current.problem).toBe(
			`${projectFile()}: entry 1: expected { "bash": "<rule>", "project": "<absolute folder>" }; no saved project rule is used`,
		);
	});
});

describe("a rule saved for every folder that is no longer allowed there", () => {
	beforeEach(async () => {
		await writeJson(globalFile(), {
			kind: "atelier.permissions",
			version: 1,
			allow: [{ bash: "open" }, { bash: "npm install" }, { bash: "julia" }],
		});
	});

	it("is not used, the others are, and it is said", async () => {
		const current = await new PermissionRules({ home, cwd: app }).current();
		expect(current.bash).toEqual(["open"]);
		expect(current.projectBash).toEqual([]);
		expect(current.problem).toBeUndefined();
		expect(current.ignored).toBe(
			`${globalFile()}: not used in every folder anymore, as they run code the project defines or any code given to them: "npm install", "julia". Allow them again in a project if you want, and remove these from the rules list`,
		);
	});

	it("is listed as ignored, kept when another rule is saved, and can be removed", async () => {
		const rules = new PermissionRules({ home, cwd: app });
		expect((await rules.list()).map(({ id, ignored }) => ({ id, ignored }))).toEqual([
			{ id: "always:bash:open", ignored: undefined },
			{ id: "always:bash:npm install", ignored: true },
			{ id: "always:bash:julia", ignored: true },
		]);
		await rules.allow([{ kind: "bash", value: "ego-browser nodejs" }], "always");
		expect((await json(globalFile())).allow).toHaveLength(4);
		expect(await rules.remove("always:bash:npm install")).toBe(true);
		expect((await json(globalFile())).allow).toEqual([
			{ bash: "open" },
			{ bash: "julia" },
			{ bash: "ego-browser nodejs" },
		]);
	});
});
