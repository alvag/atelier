import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSkills, MAX_SKILLS_BYTES, skillsPrompt } from "../src/index.ts";

let root: string;
let home: string;
beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "atelier-skills-")));
	home = join(root, "home");
	await mkdir(home);
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function put(path: string, text: string) {
	await mkdir(dirname(join(root, path)), { recursive: true });
	await writeFile(join(root, path), text);
}

function skill(name: string, description: string) {
	return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody.\n`;
}

describe("loadSkills", () => {
	it("finds the user's skills and the project's, from the working directory up to the repo root", async () => {
		await mkdir(join(root, "repo/.git"), { recursive: true });
		await put("repo/.agents/skills/root-skill/SKILL.md", skill("root-skill", "At the repo root."));
		await put("repo/app/.agents/skills/app-skill/SKILL.md", skill("app-skill", "In the app."));
		await put(".agents/skills/above/SKILL.md", skill("above", "Above the repo."));
		await put("home/.agents/skills/mine/SKILL.md", skill("mine", "The user's."));
		await put("home/.claude/skills/claude/SKILL.md", skill("claude", "Never read."));
		await put("repo/.claude/skills/claude2/SKILL.md", skill("claude2", "Never read."));
		const loaded = await loadSkills(join(root, "repo/app"), home);
		expect(loaded.skills).toEqual([
			{ name: "app-skill", description: "In the app.", path: join(root, "repo/app/.agents/skills/app-skill/SKILL.md") },
			{
				name: "root-skill",
				description: "At the repo root.",
				path: join(root, "repo/.agents/skills/root-skill/SKILL.md"),
			},
			{ name: "mine", description: "The user's.", path: join(home, ".agents/skills/mine/SKILL.md") },
		]);
		expect(loaded.warnings).toEqual([]);
	});

	it("reads only the working directory outside a repository", async () => {
		await put("work/sub/.agents/skills/here/SKILL.md", skill("here", "Here."));
		await put("work/.agents/skills/parent/SKILL.md", skill("parent", "Parent."));
		const loaded = await loadSkills(join(root, "work/sub"), home);
		expect(loaded.skills.map(({ name }) => name)).toEqual(["here"]);
	});

	it("takes the root of a worktree, whose .git is a file", async () => {
		await put("wt/.git", "gitdir: /elsewhere\n");
		await put("wt/.agents/skills/wt-skill/SKILL.md", skill("wt-skill", "Worktree."));
		const loaded = await loadSkills(join(root, "wt/deep/er"), home);
		expect(loaded.skills.map(({ name }) => name)).toEqual(["wt-skill"]);
	});

	it("keeps the first of two skills with the same name and warns about the other", async () => {
		await put("work/.agents/skills/dup/SKILL.md", skill("dup", "Project."));
		await put("home/.agents/skills/dup/SKILL.md", skill("dup", "User."));
		const loaded = await loadSkills(join(root, "work"), home);
		expect(loaded.skills).toEqual([
			{ name: "dup", description: "Project.", path: join(root, "work/.agents/skills/dup/SKILL.md") },
		]);
		expect(loaded.warnings).toEqual([
			{
				path: join(home, ".agents/skills/dup/SKILL.md"),
				message: `skill "dup" is already loaded from ${join(root, "work/.agents/skills/dup/SKILL.md")}; this one is ignored`,
			},
		]);
	});

	it("does not load a skill without a description or with broken frontmatter, and says why", async () => {
		await put("work/.agents/skills/empty/SKILL.md", "---\nname: empty\n---\nBody.\n");
		await put("work/.agents/skills/plain/SKILL.md", "# No frontmatter\n");
		await put("work/.agents/skills/broken/SKILL.md", "---\nname: broken\ndescription: [unclosed\n---\n");
		await put("work/.agents/skills/open/SKILL.md", "---\nname: open\ndescription: never closed\n");
		const loaded = await loadSkills(join(root, "work"), home);
		expect(loaded.skills).toEqual([]);
		const at = (name: string) => join(root, "work/.agents/skills", name, "SKILL.md");
		expect(loaded.warnings).toEqual([
			{ path: at("broken"), message: expect.stringMatching(/^invalid frontmatter: .+[^:]; not loaded$/) },
			{ path: at("empty"), message: "no description; not loaded" },
			{ path: at("open"), message: "invalid frontmatter: no closing ---; not loaded" },
			{ path: at("plain"), message: "no description; not loaded" },
		]);
	});

	it("reads folded descriptions, takes the folder's name when there is none, and does not mind a name unlike its folder", async () => {
		await put("work/.agents/skills/folded/SKILL.md", "---\ndescription: >\n  One\n  line.\n---\n");
		await put("work/.agents/skills/folder/SKILL.md", skill("other-name", "Renamed."));
		const loaded = await loadSkills(join(root, "work"), home);
		expect(loaded.skills.map(({ name, description }) => ({ name, description }))).toEqual([
			{ name: "folded", description: "One line." },
			{ name: "other-name", description: "Renamed." },
		]);
		expect(loaded.warnings).toEqual([]);
	});

	it("loads a skill with an invalid name or a long description, with a warning", async () => {
		await put("work/.agents/skills/bad/SKILL.md", skill("Bad_Name", "Fine."));
		await put("work/.agents/skills/long/SKILL.md", skill("long", "x".repeat(1025)));
		const loaded = await loadSkills(join(root, "work"), home);
		expect(loaded.skills.map(({ name }) => name)).toEqual(["Bad_Name", "long"]);
		expect(loaded.warnings).toEqual([
			{
				path: join(root, "work/.agents/skills/bad/SKILL.md"),
				message: 'name "Bad_Name" should be lowercase letters, digits and hyphens, at most 64',
			},
			{
				path: join(root, "work/.agents/skills/long/SKILL.md"),
				message: "description is longer than 1024 characters; cut to 1024",
			},
		]);
		expect(loaded.skills[1]?.description).toBe("x".repeat(1024));
		expect(skillsPrompt(loaded.skills)).toContain(`<description>${"x".repeat(1024)}</description>`);
		expect(skillsPrompt(loaded.skills)).not.toContain("x".repeat(1025));
	});

	it("counts characters, not UTF-16 units, when it cuts a description", async () => {
		await put("work/.agents/skills/emoji/SKILL.md", skill("emoji", "😀".repeat(1030)));
		const loaded = await loadSkills(join(root, "work"), home);
		expect(loaded.skills[0]?.description).toBe("😀".repeat(1024));
	});

	it("lists skills up to the cap, in the order found, and warns about each one left out", async () => {
		const description = "d".repeat(1000);
		for (let i = 0; i < 30; i++) {
			const name = `s${String(i).padStart(2, "0")}`;
			await put(`work/.agents/skills/${name}/SKILL.md`, skill(name, description));
		}
		const loaded = await loadSkills(join(root, "work"), home);
		const prompt = skillsPrompt(loaded.skills);
		expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(MAX_SKILLS_BYTES);
		expect(loaded.skills.length).toBeGreaterThan(0);
		expect(loaded.skills.length).toBeLessThan(30);
		expect(loaded.skills.map(({ name }) => name)).toEqual(
			Array.from({ length: loaded.skills.length }, (_, i) => `s${String(i).padStart(2, "0")}`),
		);
		expect(loaded.warnings).toEqual(
			Array.from({ length: 30 - loaded.skills.length }, (_, i) => {
				const name = `s${String(loaded.skills.length + i).padStart(2, "0")}`;
				return {
					path: join(root, "work/.agents/skills", name, "SKILL.md"),
					message: "the skills list is over 24 KiB; not listed",
				};
			}),
		);
	});

	it("says a description that is not text must be a string", async () => {
		await put("work/.agents/skills/number/SKILL.md", "---\nname: number\ndescription: 42\n---\n");
		await put("work/.agents/skills/list/SKILL.md", "---\nname: list\ndescription: [a, b]\n---\n");
		const loaded = await loadSkills(join(root, "work"), home);
		expect(loaded.skills).toEqual([]);
		expect(loaded.warnings).toEqual([
			{ path: join(root, "work/.agents/skills/list/SKILL.md"), message: "description must be a string; not loaded" },
			{ path: join(root, "work/.agents/skills/number/SKILL.md"), message: "description must be a string; not loaded" },
		]);
	});

	it("says nothing about an invalid sandbox configuration when there are no skills", async () => {
		await put("home/.atelier/sandbox.json", "{ not json");
		expect(await loadSkills(join(root, "work"), home)).toEqual({ skills: [], warnings: [] });
	});

	it("loads no skill when the sandbox configuration is invalid, and says why", async () => {
		await put("work/.agents/skills/ok/SKILL.md", skill("ok", "Fine."));
		await put("home/.atelier/sandbox.json", "{ not json");
		const loaded = await loadSkills(join(root, "work"), home);
		expect(loaded.skills).toEqual([]);
		expect(loaded.warnings).toEqual([
			{
				path: join(root, "work"),
				message: expect.stringMatching(
					new RegExp(`^no skills loaded: Invalid sandbox configuration ${join(home, ".atelier", "sandbox.json")}: .+`),
				),
			},
		]);
	});

	it("skips hidden folders and folders without SKILL.md, and follows linked skill folders", async () => {
		await put("work/.agents/skills/.hidden/SKILL.md", skill("hidden", "Hidden."));
		await put("work/.agents/skills/notes/README.md", "no skill");
		await put("shared/linked/SKILL.md", skill("linked", "Linked."));
		await symlink(join(root, "shared/linked"), join(root, "work/.agents/skills/linked"));
		const loaded = await loadSkills(join(root, "work"), home);
		expect(loaded.skills).toEqual([
			{ name: "linked", description: "Linked.", path: join(root, "work/.agents/skills/linked/SKILL.md") },
		]);
		expect(loaded.warnings).toEqual([]);
	});

	it("skips a skill that lives in a protected location, which read would refuse", async () => {
		await put("home/.claude/skills/secret/SKILL.md", skill("secret", "Behind .claude."));
		await mkdir(join(home, ".agents/skills"), { recursive: true });
		await symlink(join(home, ".claude/skills/secret"), join(home, ".agents/skills/secret"));
		const loaded = await loadSkills(join(root, "work-none"), home);
		expect(loaded.skills).toEqual([]);
		expect(loaded.warnings).toEqual([
			{
				path: join(home, ".agents/skills/secret/SKILL.md"),
				message: "it is in a protected location the agent cannot read; not loaded",
			},
		]);
	});

	it("reads the user's folder once when the repository is the home", async () => {
		await mkdir(join(home, ".git"));
		await put("home/.agents/skills/mine/SKILL.md", skill("mine", "Once."));
		const loaded = await loadSkills(join(home, "project"), home);
		expect(loaded.skills.map(({ name }) => name)).toEqual(["mine"]);
		expect(loaded.warnings).toEqual([]);
	});
});
