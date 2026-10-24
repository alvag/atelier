import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSandboxAdditions, SandboxConfigError } from "../src/tools/sandbox-config.ts";

let base: string;
let home: string;
let cwd: string;

beforeEach(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), "atelier-sandbox-config-")));
	home = join(base, "home");
	cwd = join(base, "project");
	await mkdir(join(home, ".atelier"), { recursive: true });
	await mkdir(join(cwd, ".atelier"), { recursive: true });
});

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

const userFile = () => join(home, ".atelier", "sandbox.json");
const projectFile = () => join(cwd, ".atelier", "sandbox.json");
const writeUser = (config: unknown) =>
	writeFile(userFile(), typeof config === "string" ? config : JSON.stringify(config));
const writeProject = (config: unknown) =>
	writeFile(projectFile(), typeof config === "string" ? config : JSON.stringify(config));
const load = () => loadSandboxAdditions({ home, cwd });

function failure(): string {
	try {
		load();
	} catch (error) {
		expect(error).toBeInstanceOf(SandboxConfigError);
		return (error as Error).message;
	}
	throw new Error("expected the configuration to be refused");
}

describe("loadSandboxAdditions", () => {
	it("adds nothing when neither file exists", async () => {
		await rm(join(home, ".atelier"), { recursive: true });
		await rm(join(cwd, ".atelier"), { recursive: true });
		expect(load()).toEqual({ allowWrite: [], denyRead: [] });
	});

	it("reads the user file relative to home, with ~/ and absolute paths", async () => {
		await writeUser({ allowWrite: ["work", "~/more", join(base, "abs")], denyRead: ["Documents", "~/Private"] });
		expect(load()).toEqual({
			allowWrite: [join(home, "work"), join(home, "more"), join(base, "abs")],
			denyRead: [join(home, "Documents"), join(home, "Private")],
		});
	});

	it("reads the project file relative to the working directory, also with ..", async () => {
		await writeProject({ allowWrite: ["build-cache", "../shared"], denyRead: ["vendor/private"] });
		expect(load()).toEqual({
			allowWrite: [join(cwd, "build-cache"), join(base, "shared")],
			denyRead: [join(cwd, "vendor", "private")],
		});
	});

	it("adds the project's entries after the user's", async () => {
		await writeUser({ allowWrite: ["a"] });
		await writeProject({ allowWrite: ["b"], denyRead: ["c"] });
		expect(load()).toEqual({ allowWrite: [join(home, "a"), join(cwd, "b")], denyRead: [join(cwd, "c")] });
	});

	it("accepts a file with either key or neither", async () => {
		await writeUser({});
		await writeProject({ denyRead: ["x"] });
		expect(load()).toEqual({ allowWrite: [], denyRead: [join(cwd, "x")] });
	});

	it("allows a write path that is not near a protected one", async () => {
		await writeUser({ allowWrite: ["~/work", "~/.sshfs-mounts"] });
		expect(load().allowWrite).toEqual([join(home, "work"), join(home, ".sshfs-mounts")]);
	});

	it("names the file and the problem when the JSON is invalid", async () => {
		await writeUser("{ not json");
		expect(failure()).toMatch(new RegExp(`^Invalid sandbox configuration ${userFile()}: not valid JSON \\(.+\\)$`));
	});

	it("names the project file when that one is invalid", async () => {
		await writeUser({});
		await writeProject("[]");
		expect(failure()).toBe(
			`Invalid sandbox configuration ${projectFile()}: must be a JSON object, for example {"allowWrite": ["~/work"], "denyRead": ["~/Documents"]}`,
		);
	});

	it.each([
		["null", "null"],
		["a string", '"x"'],
	])("refuses %s as the whole file", async (_name, text) => {
		await writeUser(text);
		expect(failure()).toContain("must be a JSON object");
	});

	it("refuses an unknown key", async () => {
		await writeUser({ allowWrite: [], allowRead: ["/"] });
		expect(failure()).toBe(
			`Invalid sandbox configuration ${userFile()}: unknown key "allowRead" (the keys are "allowWrite" and "denyRead")`,
		);
	});

	it.each([
		["allowWrite", "x"],
		["allowWrite", [1]],
		["denyRead", [""]],
		["denyRead", { a: 1 }],
	])("refuses %s set to %j", async (key, value) => {
		await writeProject({ [key]: value });
		expect(failure()).toBe(
			`Invalid sandbox configuration ${projectFile()}: "${key}" must be an array of non-empty strings`,
		);
	});

	it("reports an unreadable file with its path", async () => {
		await mkdir(userFile());
		expect(failure()).toMatch(new RegExp(`^Invalid sandbox configuration ${userFile()}: could not be read \\(.+\\)$`));
	});

	describe("refuses an allowWrite entry that would make a protected path writable", () => {
		it.each([
			["~", "~", "home"],
			["/", "/", "home"],
			["the parent of home", "..", "home"],
			["~/.ssh", "~/.ssh", ".ssh"],
			["~/.ssh/keys", "~/.ssh/keys", ".ssh"],
			["~/.aws", "~/.aws", ".aws"],
			["~/.gnupg", "~/.gnupg", ".gnupg"],
			["~/.config/gh", "~/.config/gh", ".config/gh"],
			["~/.config", "~/.config", ".config/gh"],
			["~/Library/Keychains", "~/Library/Keychains", "Library/Keychains"],
			["~/Library", "~/Library", "Library/Keychains"],
			["~/.claude", "~/.claude", ".claude"],
			["~/.atelier", "~/.atelier", ".atelier"],
			["a trailing slash", "~/.ssh/", ".ssh"],
			["a dot segment", "~/work/../.ssh", ".ssh"],
		])("%s", async (_name, entry, protectedPath) => {
			await writeUser({ allowWrite: [entry] });
			const message = failure();
			expect(message).toContain(
				`Invalid sandbox configuration ${userFile()}: allowWrite entry ${JSON.stringify(entry)} is refused`,
			);
			expect(message).toContain(protectedPath === "home" ? home : join(home, protectedPath));
			expect(message).toMatch(/stays? protected$/);
		});

		it("also in the project file, with a relative path that climbs to a protected one", async () => {
			const relative = join("..", "home", ".ssh");
			await writeProject({ allowWrite: [relative] });
			expect(failure()).toContain(
				`Invalid sandbox configuration ${projectFile()}: allowWrite entry ${JSON.stringify(relative)} is refused`,
			);
		});

		it("through a symbolic link that points at a protected path", async () => {
			await mkdir(join(home, ".ssh"));
			await symlink(join(home, ".ssh"), join(home, "innocent"));
			await writeUser({ allowWrite: ["~/innocent"] });
			expect(failure()).toContain(`allowWrite entry "~/innocent" is refused`);
			expect(failure()).toContain(join(home, ".ssh"));
		});

		it("says whether the entry covers the protected path or lies inside it", async () => {
			await writeUser({ allowWrite: ["~"] });
			expect(failure()).toMatch(/would make .+ writable/);
			await writeUser({ allowWrite: ["~/.ssh/keys"] });
			expect(failure()).toMatch(/is inside .+/);
		});

		it("does not refuse a protected path in denyRead, which only restricts", async () => {
			await writeUser({ denyRead: ["~", "~/.ssh", "/"] });
			expect(load().denyRead).toEqual([home, join(home, ".ssh"), "/"]);
		});
	});
});
