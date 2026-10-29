import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { profilesPath, readProfiles, resolveProfile, roleEntry } from "../src/index.ts";

let base: string;
let home: string;
let repo: string;

beforeEach(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), "atelier-profiles-")));
	home = join(base, "home");
	repo = join(base, "repo");
	await mkdir(join(home, ".atelier"), { recursive: true });
	await mkdir(repo);
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
});

afterEach(() => rm(base, { recursive: true, force: true }));

const file = (body: object) => JSON.stringify({ kind: "atelier.agent_model_profiles", version: 1, ...body });
const pin = (profile: string) => JSON.stringify({ kind: "atelier.profile_pin", version: 1, profile });
const setProfiles = (body: object) => writeFile(profilesPath(home), file(body));
const messages = (reports: { message: string }[]) => reports.map((r) => r.message);

describe("resolveProfile", () => {
	const profiles = {
		active: "global",
		profiles: {
			global: { worker: { model: "g" } },
			declared: { worker: { model: "r" } },
			pinned: { worker: { model: "l" }, verifier: { thinking: "low" } },
			chosen: { worker: { model: "c" } },
		},
	};
	const writePins = async () => {
		await mkdir(join(repo, ".git", "atelier"));
		await writeFile(join(repo, ".git", "atelier", "profile-pin.json"), pin("pinned"));
		await mkdir(join(repo, ".atelier"));
		await writeFile(join(repo, ".atelier", "profile.json"), pin("declared"));
	};

	it("is the default profile without any file: everything inherits", async () => {
		const resolved = await resolveProfile({ cwd: repo, home });
		expect(resolved).toEqual({ origin: "default", profile: {}, reports: [] });
		expect(roleEntry(resolved, "worker")).toEqual({});
	});

	it("resolves from the profiles it is given instead of reading the file again", async () => {
		await setProfiles(profiles);
		const read = await readProfiles(home);
		await setProfiles({ active: "other", profiles: { other: { worker: { model: "o" } } } });
		const resolved = await resolveProfile({ cwd: repo, home, profiles: read });
		expect([resolved.origin, resolved.name, roleEntry(resolved, "worker").model]).toEqual(["active", "global", "g"]);
	});

	it("goes explicit, then local pin, then repo declaration, then active, then default", async () => {
		await setProfiles(profiles);
		const origins = async (choice?: string) => {
			const r = await resolveProfile({ cwd: repo, home, ...(choice === undefined ? {} : { choice }) });
			return [r.origin, r.name, roleEntry(r, "worker").model];
		};
		expect(await origins()).toEqual(["active", "global", "g"]);
		await mkdir(join(repo, ".atelier"));
		await writeFile(join(repo, ".atelier", "profile.json"), pin("declared"));
		expect(await origins()).toEqual(["repo", "declared", "r"]);
		await mkdir(join(repo, ".git", "atelier"));
		await writeFile(join(repo, ".git", "atelier", "profile-pin.json"), pin("pinned"));
		expect(await origins()).toEqual(["local-pin", "pinned", "l"]);
		expect(await origins("chosen")).toEqual(["explicit", "chosen", "c"]);
	});

	it("resolves from a subdirectory of the repository", async () => {
		await setProfiles(profiles);
		await writePins();
		await mkdir(join(repo, "sub"));
		const resolved = await resolveProfile({ cwd: join(repo, "sub"), home });
		expect([resolved.origin, resolved.name]).toEqual(["local-pin", "pinned"]);
	});

	it("falls back to the default profile for a role the chosen profile leaves out, never to another profile", async () => {
		await setProfiles(profiles);
		await writePins();
		const resolved = await resolveProfile({ cwd: repo, home });
		expect(roleEntry(resolved, "verifier")).toEqual({ thinking: "low" });
		expect(roleEntry(resolved, "explorer")).toEqual({});
	});

	it("reports a stale active and uses the default profile, without clearing it", async () => {
		await setProfiles({ active: "gone", profiles: profiles.profiles });
		const resolved = await resolveProfile({ cwd: repo, home });
		expect([resolved.origin, resolved.name, resolved.profile]).toEqual(["default", undefined, {}]);
		expect(messages(resolved.reports)).toEqual(['profile "gone" does not exist, skipped']);
		expect(JSON.parse(await readFile(profilesPath(home), "utf8")).active).toBe("gone");
	});

	it("reports a pin or a choice naming a missing profile and goes on to the next layer", async () => {
		await setProfiles(profiles);
		await mkdir(join(repo, ".git", "atelier"));
		await writeFile(join(repo, ".git", "atelier", "profile-pin.json"), pin("gone"));
		const resolved = await resolveProfile({ cwd: repo, home, choice: "also-gone" });
		expect([resolved.origin, resolved.name]).toEqual(["active", "global"]);
		expect(messages(resolved.reports)).toEqual([
			'profile "also-gone" does not exist, skipped',
			'profile "gone" does not exist, skipped',
		]);
	});

	it("drops and reports invalid pins and an invalid profiles file", async () => {
		await writeFile(profilesPath(home), JSON.stringify({ kind: "nope", version: 1, profiles: {} }));
		await mkdir(join(repo, ".git", "atelier"));
		await writeFile(
			join(repo, ".git", "atelier", "profile-pin.json"),
			'{"kind":"atelier.profile_pin","version":9,"profile":"a"}',
		);
		await mkdir(join(repo, ".atelier"));
		await writeFile(join(repo, ".atelier", "profile.json"), "{bad");
		const resolved = await resolveProfile({ cwd: repo, home });
		expect(resolved.origin).toBe("default");
		expect(messages(resolved.reports).sort()).toEqual([
			'expected kind "atelier.agent_model_profiles" and version 1: the file is ignored',
			'expected kind "atelier.profile_pin" and version 1, pin ignored',
			"not valid JSON, pin ignored",
		]);
	});

	it("ignores a pin whose name is not valid, naming it, and goes on to the next layer", async () => {
		await setProfiles(profiles);
		await mkdir(join(repo, ".git", "atelier"));
		await writeFile(join(repo, ".git", "atelier", "profile-pin.json"), pin("bad name"));
		const resolved = await resolveProfile({ cwd: repo, home });
		expect([resolved.origin, resolved.name]).toEqual(["active", "global"]);
		expect(messages(resolved.reports)).toEqual(['"profile" is not a valid profile name ("bad name"), pin ignored']);
	});

	it("ignores the repository's declaration whose name is not valid, naming it, and goes on to the next layer", async () => {
		await setProfiles(profiles);
		await mkdir(join(repo, ".atelier"));
		await writeFile(join(repo, ".atelier", "profile.json"), pin("bad name"));
		const resolved = await resolveProfile({ cwd: repo, home });
		expect([resolved.origin, resolved.name]).toEqual(["active", "global"]);
		expect(messages(resolved.reports)).toEqual(['"profile" is not a valid profile name ("bad name"), pin ignored']);
	});

	it("reports a chosen name that is not valid and goes on to the next layer", async () => {
		await setProfiles(profiles);
		const resolved = await resolveProfile({ cwd: repo, home, choice: "bad name" });
		expect([resolved.origin, resolved.name]).toEqual(["active", "global"]);
		expect(messages(resolved.reports)).toEqual(['profile "bad name" is not a valid profile name, skipped']);
	});

	it("ignores the profiles of a name that is not valid, keeping the rest of the file", async () => {
		await setProfiles({ active: "global", profiles: { ...profiles.profiles, "bad name": { worker: { model: "x" } } } });
		const resolved = await resolveProfile({ cwd: repo, home });
		expect([resolved.origin, resolved.name]).toEqual(["active", "global"]);
		expect(messages(resolved.reports)).toEqual(['profile "bad name": invalid profile name, dropped']);
	});

	it("outside a git repository only the choice and the global active apply", async () => {
		await setProfiles(profiles);
		const plain = join(base, "plain");
		await mkdir(plain);
		expect((await resolveProfile({ cwd: plain, home })).origin).toBe("active");
		expect((await resolveProfile({ cwd: plain, home, choice: "chosen" })).origin).toBe("explicit");
	});
});
