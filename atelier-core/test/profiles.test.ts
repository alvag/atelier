import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	describeProfileName,
	formatModel,
	isValidProfileName,
	PROFILE_NAME_RULE,
	ProfileNameError,
	type ProfilesFile,
	parseModel,
	parseProfiles,
	profilesPath,
	readProfiles,
	writeProfiles,
} from "../src/index.ts";

let base: string;
let home: string;

beforeEach(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), "atelier-profiles-")));
	home = join(base, "home");
	await mkdir(join(home, ".atelier"), { recursive: true });
});

afterEach(() => rm(base, { recursive: true, force: true }));

const file = (body: object) => JSON.stringify({ kind: "atelier.agent_model_profiles", version: 1, ...body });
const messages = (reports: { message: string }[]) => reports.map((r) => r.message);

describe("parseProfiles", () => {
	it("reads models, backend prefixes and levels, with effort as the alias of thinking", () => {
		const read = parseProfiles(
			file({
				active: "cheap",
				profiles: {
					cheap: {
						verifier: { model: "anthropic-api/claude-sonnet-5-5", thinking: "medium" },
						worker: { model: "claude-code/opus", effort: "max" },
						explorer: { model: "claude-haiku-5-5" },
						compaction: { thinking: "off", effort: "high" },
					},
				},
			}),
		);
		if (!read.valid) throw new Error(read.reason);
		expect(read.reports).toEqual([]);
		expect(read.file.active).toBe("cheap");
		expect(read.file.profiles.get("cheap")).toEqual({
			verifier: { backend: "anthropic-api", model: "claude-sonnet-5-5", thinking: "medium" },
			worker: { backend: "claude-code", model: "opus", thinking: "max" },
			explorer: { model: "claude-haiku-5-5" },
			compaction: { thinking: "off" },
		});
	});

	it.each([
		["a wrong kind", { kind: "other", version: 1, profiles: {} }],
		["a wrong version", { kind: "atelier.agent_model_profiles", version: 2, profiles: {} }],
		["no kind or version", { profiles: {} }],
	])("is invalid as a whole with %s", (_name, body) => {
		const read = parseProfiles(JSON.stringify(body));
		expect(read.valid).toBe(false);
	});

	it("is invalid as a whole when it is not JSON", () => {
		expect(parseProfiles("{nope").valid).toBe(false);
	});

	it("drops and reports invalid content, keeping the rest", () => {
		const read = parseProfiles(
			file({
				profiles: {
					broken: "text",
					p: {
						verifer: { model: "x" },
						"review-risks": { model: "x" },
						nonsense: { model: "x" },
						worker: { model: "bad model!", thinking: "medium" },
						explorer: { thinking: "turbo" },
						orchestrator: "no",
						"review-risk": { model: "claude-code/" },
						compaction: { model: "ok-model" },
					},
				},
			}),
		);
		if (!read.valid) throw new Error(read.reason);
		expect(read.file.profiles.has("broken")).toBe(false);
		expect(read.file.profiles.get("p")).toEqual({
			worker: { thinking: "medium" },
			compaction: { model: "ok-model" },
		});
		const text = messages(read.reports).join("\n");
		expect(text).toContain('profile "broken": not an object');
		expect(text).toContain('unknown role "verifer", did you mean "verifier"?');
		expect(text).toContain('unknown role "review-risks", did you mean "review-risk"?');
		expect(text).toMatch(/unknown role "nonsense", dropped/);
		expect(text).toContain('role "worker": unsafe or empty model');
		expect(text).toContain('role "explorer": unknown level for thinking');
		expect(text).toContain('role "orchestrator": not an object');
		expect(text).toContain('no model after the "claude-code/" prefix');
	});

	it("lets a valid thinking win over effort, and falls back to effort when thinking is unknown", () => {
		const read = parseProfiles(
			file({
				profiles: { p: { worker: { thinking: "low", effort: "max" }, explorer: { thinking: "x", effort: "high" } } },
			}),
		);
		if (!read.valid) throw new Error(read.reason);
		expect(read.file.profiles.get("p")).toEqual({ worker: { thinking: "low" }, explorer: { thinking: "high" } });
	});
});

describe("profile names", () => {
	it("accepts names of letters, digits, dots, underscores and dashes, up to 64 characters", () => {
		for (const name of ["a", "A", "0", "cheap", "my-profile", "my_profile", "my.profile", "a1._-", "x".repeat(64)]) {
			expect(isValidProfileName(name)).toBe(true);
		}
	});

	it("refuses empty names, names with spaces or other characters, and names longer than 64 characters", () => {
		for (const name of ["", " ", "my profile", "my/profile", "_leading", "-leading", ".leading", "x".repeat(65)])
			expect(isValidProfileName(name)).toBe(false);
	});

	it("refuses the names that collide with the members of an object", () => {
		for (const name of ["__proto__", "constructor", "prototype"]) expect(isValidProfileName(name)).toBe(false);
	});

	it("refuses a name that is not a string", () => {
		for (const value of [undefined, null, 5, {}, []]) expect(isValidProfileName(value)).toBe(false);
	});

	it("describes any value without throwing, even one JSON cannot write", () => {
		expect(describeProfileName("plain")).toBe('"plain"');
		expect(describeProfileName("with space")).toBe('"with space"');
		expect(describeProfileName(5)).toBe("5");
		expect(describeProfileName(undefined)).toBe("undefined");
		expect(describeProfileName(null)).toBe("null");
		expect(describeProfileName({ a: 1 })).toBe('{"a":1}');
		// JSON.stringify throws on a BigInt; the name is described all the same.
		expect(describeProfileName(10n)).toBe("10");
	});

	it("drops a profile whose name is not valid, naming the entry, and keeps the rest of the file", () => {
		const read = parseProfiles(
			file({
				profiles: {
					"bad name": { worker: { model: "m" } },
					"": { worker: { model: "m" } },
					good: { worker: { model: "m" } },
				},
			}),
		);
		if (!read.valid) throw new Error(read.reason);
		expect([...read.file.profiles.keys()]).toEqual(["good"]);
		expect(messages(read.reports)).toEqual([
			`profile "bad name": invalid profile name, dropped. ${PROFILE_NAME_RULE}`,
			`profile "": invalid profile name, dropped. ${PROFILE_NAME_RULE}`,
		]);
	});

	it("drops the reserved names, naming the entry", () => {
		const read = parseProfiles(
			'{"kind":"atelier.agent_model_profiles","version":1,"profiles":{"__proto__":{"worker":{"model":"m"}},"constructor":{},"prototype":{},"good":{}}}',
		);
		if (!read.valid) throw new Error(read.reason);
		expect([...read.file.profiles.keys()]).toEqual(["good"]);
		expect(messages(read.reports)).toEqual([
			`profile "__proto__": invalid profile name, dropped. ${PROFILE_NAME_RULE}`,
			`profile "constructor": invalid profile name, dropped. ${PROFILE_NAME_RULE}`,
			`profile "prototype": invalid profile name, dropped. ${PROFILE_NAME_RULE}`,
		]);
	});

	it("quotes the name of a dropped entry, so it cannot break the line it is read on", () => {
		const read = parseProfiles(file({ profiles: { 'a "quoted"\nname': {} } }));
		if (!read.valid) throw new Error(read.reason);
		expect(messages(read.reports)).toEqual([
			`profile "a \\"quoted\\"\\nname": invalid profile name, dropped. ${PROFILE_NAME_RULE}`,
		]);
	});

	it("echoes the invalid active value and ignores it", () => {
		const read = parseProfiles(file({ active: "bad name", profiles: { good: {} } }));
		if (!read.valid) throw new Error(read.reason);
		expect(read.file.active).toBeUndefined();
		expect(messages(read.reports)).toEqual([
			`"active" is not a valid profile name ("bad name"), ignored. ${PROFILE_NAME_RULE}`,
		]);
	});

	it("echoes an active that is not a string, and ignores it", () => {
		const read = parseProfiles(file({ active: 5, profiles: { good: {} } }));
		if (!read.valid) throw new Error(read.reason);
		expect(read.file.active).toBeUndefined();
		expect(messages(read.reports)).toEqual([`"active" is not a profile name (5), ignored. ${PROFILE_NAME_RULE}`]);
	});

	it("keeps an active that is a valid name", () => {
		const read = parseProfiles(file({ active: "good", profiles: { good: {} } }));
		if (!read.valid) throw new Error(read.reason);
		expect(read.file.active).toBe("good");
		expect(read.reports).toEqual([]);
	});
});

describe("readProfiles and writeProfiles", () => {
	it("treats a missing file as no profiles", async () => {
		const read = await readProfiles(join(base, "nobody"));
		expect(read).toEqual({ valid: true, file: { profiles: new Map() }, reports: [] });
	});

	it("writes atomically and reads back what it wrote, leaving no temporary file", async () => {
		const written: ProfilesFile = {
			active: "a",
			profiles: new Map([["a", { verifier: { backend: "claude-code", model: "opus", thinking: "high" } }]]),
		};
		await writeProfiles(written, home);
		expect(JSON.parse(await readFile(profilesPath(home), "utf8"))).toEqual({
			kind: "atelier.agent_model_profiles",
			version: 1,
			active: "a",
			profiles: { a: { verifier: { model: "claude-code/opus", thinking: "high" } } },
		});
		const read = await readProfiles(home);
		expect(read.valid && read.file).toEqual(written);
		expect(await readdir(join(home, ".atelier"))).toEqual(["profiles.json"]);
	});

	it("refuses to write a profile whose name is not valid, and writes nothing", async () => {
		const file: ProfilesFile = { profiles: new Map([["bad name", { worker: { model: "m" } }]]) };
		await expect(writeProfiles(file, home)).rejects.toThrow(ProfileNameError);
		await expect(writeProfiles(file, home)).rejects.toThrow('Invalid profile name "bad name"');
		expect(await readdir(join(home, ".atelier"))).toEqual([]);
	});

	it("refuses to write the names that collide with the members of an object", async () => {
		for (const name of ["__proto__", "constructor", "prototype"]) {
			const file: ProfilesFile = { profiles: new Map([[name, { worker: { model: "m" } }]]) };
			await expect(writeProfiles(file, home)).rejects.toThrow(ProfileNameError);
		}
		expect(await readdir(join(home, ".atelier"))).toEqual([]);
	});

	it("refuses to write an active that is not a valid name, and writes nothing", async () => {
		const file: ProfilesFile = { active: "bad name", profiles: new Map([["good", {}]]) };
		await expect(writeProfiles(file, home)).rejects.toThrow(ProfileNameError);
		expect(await readdir(join(home, ".atelier"))).toEqual([]);
	});
});

describe("parseModel", () => {
	it("splits a backend prefix from the model, as a profile reads it, and formatModel puts it back", () => {
		expect(parseModel("openai-codex/gpt-6-luna")).toEqual({
			ok: true,
			entry: { backend: "openai-codex", model: "gpt-6-luna" },
		});
		expect(parseModel("sonnet")).toEqual({ ok: true, entry: { model: "sonnet" } });
		expect(parseModel("vendor/model")).toEqual({ ok: true, entry: { model: "vendor/model" } });
		expect(parseModel("claude-code/")).toEqual({ ok: false, why: 'no model after the "claude-code/" prefix' });
		expect(parseModel("two words")).toEqual({ ok: false, why: "unsafe or empty model" });
		expect(formatModel("opencode-go", "minimax-m3")).toBe("opencode-go/minimax-m3");
	});
});
