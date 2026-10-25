import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ProfilesFile, parseProfiles, profilesPath, readProfiles, writeProfiles } from "../src/index.ts";

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

	it("keeps a profile named like an object property as an ordinary profile", () => {
		const read = parseProfiles(
			'{"kind":"atelier.agent_model_profiles","version":1,"profiles":{"__proto__":{"worker":{"model":"m"}}}}',
		);
		if (!read.valid) throw new Error(read.reason);
		expect(read.file.profiles.get("__proto__")).toEqual({ worker: { model: "m" } });
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
});
