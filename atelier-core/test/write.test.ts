import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ApprovalRequest,
	type AtelierEvent,
	FakeBackend,
	type FakeStep,
	Session,
	type SessionOptions,
} from "../src/index.ts";
import { BUILTIN_AGENTS } from "../src/subagents/definitions.ts";
import { coreTools, createEditTool, createWriteTool, MAX_WRITE_BYTES } from "../src/tools/index.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const finished: FakeStep = { event: { type: "turn_finished", stopReason: "end_turn", usage } };

let base: string;
let cwd: string;
let outside: string;
let home: string;

beforeEach(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), "atelier-write-")));
	cwd = join(base, "work");
	outside = join(base, "outside");
	home = join(base, "home");
	for (const dir of [
		cwd,
		outside,
		join(home, ".ssh"),
		join(home, ".atelier"),
		join(cwd, "odd", "tasks"),
		join(cwd, ".atelier"),
	])
		await mkdir(dir, { recursive: true });
	await writeFile(join(cwd, "inside.txt"), "old\n");
	await writeFile(join(outside, "x.txt"), "old\n");
	await writeFile(join(outside, "y.txt"), "old\n");
	await writeFile(join(cwd, "odd", "tasks", "doc.md"), "old\n");
	await writeFile(join(cwd, ".atelier", "notes.txt"), "old\n");
});

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

const writeCall = (path: string, callId: string, content = "new\n"): FakeStep => ({
	toolCall: { tool: "write", input: { path, content }, callId },
});
const editCall = (path: string, callId: string): FakeStep => ({
	toolCall: { tool: "edit", input: { path, edits: [{ oldText: "old", newText: "edited" }] }, callId },
});
const text = (path: string) => readFile(path, "utf8");
const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

/** Runs one turn per entry of `turns`, answering every question with `answer`. */
async function runTurns(
	turns: FakeStep[][],
	options: { answer?: boolean; ask?: boolean } & Partial<SessionOptions> = {},
) {
	const { answer = true, ask = true, ...rest } = options;
	const questions: ApprovalRequest[] = [];
	const backend = new FakeBackend(turns.map((steps) => [...steps, finished]));
	const session = await Session.start({
		backend,
		cwd,
		tools: [createWriteTool({ home }), createEditTool({ home })],
		...(ask
			? {
					approve: async (request: ApprovalRequest) => {
						questions.push(request);
						return answer;
					},
				}
			: {}),
		...rest,
	});
	const events: AtelierEvent[] = [];
	for (const _ of turns) for await (const event of session.send("go")) events.push(event);
	await session.close();
	return { questions, events, results: backend.toolResults };
}
const run = (calls: FakeStep[], options: Parameters<typeof runTurns>[1] = {}) => runTurns([calls], options);

describe("write where the agent could always write", () => {
	it("creates a file in the working directory without asking", async () => {
		const { questions, results } = await run([writeCall("fresh.txt", "w1", "hello\n")]);
		expect(questions).toEqual([]);
		expect(results[0]).toMatchObject({ ok: true, output: "Wrote fresh.txt (6 bytes)." });
		expect(await text(join(cwd, "fresh.txt"))).toBe("hello\n");
		expect(await text(join(cwd, "inside.txt"))).toBe("old\n");
	});

	it("creates the missing folders", async () => {
		const { questions, results } = await run([writeCall("a/b/c.txt", "w1")]);
		expect(questions).toEqual([]);
		expect(results[0]).toMatchObject({ ok: true });
		expect(await text(join(cwd, "a", "b", "c.txt"))).toBe("new\n");
	});

	it("replaces a file whole and keeps its mode; a new file is 0644", async () => {
		await chmod(join(cwd, "inside.txt"), 0o755);
		const { results } = await run([writeCall("inside.txt", "w1", "x"), writeCall("made.txt", "w2")]);
		expect(results.map((r) => r.ok)).toEqual([true, true]);
		expect(await text(join(cwd, "inside.txt"))).toBe("x");
		expect((await stat(join(cwd, "inside.txt"))).mode & 0o7777).toBe(0o755);
		expect((await stat(join(cwd, "made.txt"))).mode & 0o7777).toBe(0o644);
	});

	it("does not ask inside a directory the configuration allows writing", async () => {
		await writeFile(join(home, ".atelier", "sandbox.json"), JSON.stringify({ allowWrite: [outside] }));
		const { questions, results } = await run([writeCall(join(outside, "new", "z.txt"), "w1")]);
		expect(questions).toEqual([]);
		expect(results[0]).toMatchObject({ ok: true });
		expect(await text(join(outside, "new", "z.txt"))).toBe("new\n");
	});

	it("does not ask inside the session's scratch directory", async () => {
		const scratchDir = join(base, "scratch");
		await mkdir(scratchDir);
		const outcome = await createWriteTool({ home }).execute(
			{ path: join(scratchDir, "s.txt"), content: "s" },
			{ cwd, scratchDir },
		);
		expect(outcome.ok).toBe(true);
		expect(await text(join(scratchDir, "s.txt"))).toBe("s");
	});
});

describe("write outside the working directory", () => {
	const command = (path: string) => `write ${path}`;

	it("asks once with the real path in normal, and creates the file and its folders after approval", async () => {
		const target = join(outside, "deep", "n.txt");
		const { questions, events, results } = await run([writeCall("../outside/deep/n.txt", "w1")]);
		expect(questions).toEqual([
			{ callId: "w1", command: command(target), reason: "outside the working directory", tool: "write" },
		]);
		expect(events.find((e) => e.type === "approval_requested")).toMatchObject({
			command: command(target),
			reason: "outside the working directory",
			tool: "write",
		});
		expect(results[0]).toMatchObject({ ok: true });
		expect(await text(target)).toBe("new\n");
	});

	it("asks to replace an existing file in auto too", async () => {
		const { questions } = await run([writeCall(join(outside, "x.txt"), "w1")], { permissionMode: "auto" });
		expect(questions.map((q) => q.command)).toEqual([command(join(outside, "x.txt"))]);
		expect(await text(join(outside, "x.txt"))).toBe("new\n");
	});

	it("replaces an existing file without asking in yolo", async () => {
		const { questions, events, results } = await run([writeCall(join(outside, "x.txt"), "w1")], {
			permissionMode: "yolo",
			answer: false,
		});
		expect(questions).toEqual([]);
		expect(events.some((e) => e.type === "approval_requested")).toBe(false);
		expect(results[0]).toMatchObject({ ok: true });
		expect(await text(join(outside, "x.txt"))).toBe("new\n");
	});

	it("does not ask again for the same file in the session, and asks for another", async () => {
		const { questions } = await runTurns(
			[
				[writeCall(join(outside, "x.txt"), "w1")],
				[writeCall(join(outside, "x.txt"), "w2", "again\n"), writeCall(join(outside, "y.txt"), "w3")],
			],
			{},
		);
		expect(questions.map((q) => q.command)).toEqual([command(join(outside, "x.txt")), command(join(outside, "y.txt"))]);
		expect(await text(join(outside, "x.txt"))).toBe("again\n");
	});

	it("shares the approval with edit, both ways", async () => {
		const { questions } = await runTurns(
			[
				[editCall(join(outside, "x.txt"), "e1")],
				[writeCall(join(outside, "x.txt"), "w1", "whole\n")],
				[writeCall(join(outside, "y.txt"), "w2", "old\n")],
				[editCall(join(outside, "y.txt"), "e2")],
			],
			{},
		);
		expect(questions.map((q) => q.command)).toEqual([
			`edit ${join(outside, "x.txt")}`,
			command(join(outside, "y.txt")),
		]);
		expect(await text(join(outside, "x.txt"))).toBe("whole\n");
		expect(await text(join(outside, "y.txt"))).toBe("edited\n");
	});

	it("leaves the disk as it was and says so when the user denies", async () => {
		const target = join(outside, "deep", "n.txt");
		const { results } = await run([writeCall(target, "w1"), writeCall(join(outside, "x.txt"), "w2")], {
			answer: false,
		});
		expect(results[0]).toEqual({
			ok: false,
			output: `Not written: ${target} is outside the working directory and the user did not approve writing it.`,
		});
		expect(await exists(join(outside, "deep"))).toBe(false);
		expect(await text(join(outside, "x.txt"))).toBe("old\n");
	});

	it("leaves the disk as it was and says so when there is no way to ask", async () => {
		const target = join(outside, "deep", "n.txt");
		const { results } = await run([writeCall(target, "w1")], { ask: false });
		expect(results[0]).toMatchObject({
			ok: false,
			output: `Not written: ${target} is outside the working directory and the user did not approve writing it.`,
		});
		expect(await exists(join(outside, "deep"))).toBe(false);
	});

	it("asks with the resolved target of a symlink in the working directory", async () => {
		await symlink(join(outside, "x.txt"), join(cwd, "link.txt"));
		await symlink(outside, join(cwd, "dirlink"));
		const { questions } = await run([writeCall("link.txt", "w1"), writeCall("dirlink/fresh.txt", "w2")]);
		expect(questions.map((q) => q.command)).toEqual([
			command(join(outside, "x.txt")),
			command(join(outside, "fresh.txt")),
		]);
		expect(await text(join(outside, "x.txt"))).toBe("new\n");
		expect(await text(join(outside, "fresh.txt"))).toBe("new\n");
	});

	it("refuses to write when the approved path now leads somewhere else", async () => {
		await symlink(join(outside, "y.txt"), join(cwd, "swap.txt"));
		const approvedPaths = new Set([join(outside, "x.txt")]);
		const outcome = await createWriteTool({ home }).execute(
			{ path: "swap.txt", content: "new\n" },
			{ cwd, approvedPaths },
		);
		expect(outcome).toMatchObject({
			ok: false,
			output: `Not written: ${join(outside, "y.txt")} is outside the working directory and the user did not approve writing it.`,
		});
		expect(await text(join(outside, "y.txt"))).toBe("old\n");
		expect(await text(join(outside, "x.txt"))).toBe("old\n");
	});

	it("writes nothing outside the working directory when called without any approval", async () => {
		const outcome = await createWriteTool({ home }).execute({ path: join(outside, "n.txt"), content: "n" }, { cwd });
		expect(outcome.ok).toBe(false);
		expect(await exists(join(outside, "n.txt"))).toBe(false);
	});
});

describe("write never writes what is protected", () => {
	const refused = async (path: string, output: string, check: () => Promise<void>) => {
		const { questions, results } = await run([writeCall(path, "w1")], { permissionMode: "yolo" });
		expect(questions).toEqual([]);
		expect(results[0]).toEqual({ ok: false, output });
		await check();
	};

	it.each([
		["a secret directory of the home", () => join(home, ".ssh", "id")],
		["the user's own configuration", () => join(home, ".atelier", "new.json")],
		["a .env file outside the working directory", () => join(outside, ".env")],
		["a .pem file outside the working directory", () => join(outside, "server.pem")],
		["a .key file outside the working directory", () => join(outside, "server.key")],
	])("refuses %s without asking", async (_name, target) => {
		const path = target();
		await refused(path, `Path is a protected secret location: ${path}`, async () =>
			expect(await exists(path)).toBe(false),
		);
	});

	it("refuses a symlink in the working directory that leads to a secret directory", async () => {
		await symlink(join(home, ".ssh"), join(cwd, "sneaky"));
		await refused("sneaky/id", "Path is a protected secret location: sneaky/id", async () =>
			expect(await exists(join(home, ".ssh", "id"))).toBe(false),
		);
	});

	it.each(["odd/tasks/doc.md", "odd/tasks/new.md", "ODD/Tasks/doc.md", "odd/tasks/sub/deeper.md"])(
		"refuses the feature document %s without asking",
		async (path) => {
			await refused(path, `${path} is a feature document: change it with the feature tool, not write.`, async () => {
				expect(await text(join(cwd, "odd", "tasks", "doc.md"))).toBe("old\n");
				expect(await exists(join(cwd, "odd", "tasks", "new.md"))).toBe(false);
				expect(await exists(join(cwd, "odd", "tasks", "sub"))).toBe(false);
			});
		},
	);

	it("refuses a feature document reached through a symlink, without asking", async () => {
		await symlink(join(cwd, "odd", "tasks"), join(cwd, "alias"));
		await refused(
			"alias/doc.md",
			"alias/doc.md is a feature document: change it with the feature tool, not write.",
			async () => expect(await text(join(cwd, "odd", "tasks", "doc.md"))).toBe("old\n"),
		);
	});

	it.each([".atelier/notes.txt", ".atelier/new.json", ".atelier/deep/x.json"])(
		"refuses the project configuration %s without asking",
		async (path) => {
			await refused(path, `${path} is project configuration: the agent does not write .atelier/.`, async () => {
				expect(await text(join(cwd, ".atelier", "notes.txt"))).toBe("old\n");
				expect(await exists(join(cwd, ".atelier", "deep"))).toBe(false);
			});
		},
	);

	it("refuses project configuration given as an absolute path", async () => {
		const path = join(cwd, ".atelier", "notes.txt");
		await refused(path, `${path} is project configuration: the agent does not write .atelier/.`, async () =>
			expect(await text(path)).toBe("old\n"),
		);
	});
});

describe("write limits", () => {
	it("accepts content up to the cap and refuses what passes it, writing nothing", async () => {
		expect(MAX_WRITE_BYTES).toBe(1024 * 1024);
		const atCap = "a".repeat(MAX_WRITE_BYTES);
		const over = `${"é".repeat(MAX_WRITE_BYTES / 2)}x`;
		const { results } = await run([writeCall("cap.txt", "w1", atCap), writeCall("over.txt", "w2", over)]);
		expect(results[0]).toMatchObject({ ok: true });
		expect(results[1]).toEqual({
			ok: false,
			output: `Not written: the content is ${MAX_WRITE_BYTES + 1} bytes and write takes at most ${MAX_WRITE_BYTES} (1 MiB); write the file in parts or generate it with bash.`,
		});
		expect(await exists(join(cwd, "over.txt"))).toBe(false);
	});

	it("refuses a path that is a directory and keeps it", async () => {
		const { results } = await run([writeCall("odd", "w1")]);
		expect(results[0]).toEqual({ ok: false, output: "Not a file: odd" });
	});
});

describe("write: independent security regressions", () => {
	// Independent S2 security regressions.
	it("refuses aliases of a symlinked project configuration", async () => {
		const { rename } = await import("node:fs/promises");
		await writeFile(join(cwd, ".atelier", "sandbox.json"), "{}");
		await rename(join(cwd, ".atelier"), join(cwd, "settings"));
		await symlink(join(cwd, "settings"), join(cwd, ".atelier"));
		const { questions, results } = await run(
			[
				writeCall("settings/sandbox.json", "w1", JSON.stringify({ allowWrite: [outside] })),
				writeCall(join(outside, "x.txt"), "w2"),
			],
			{ answer: false },
		);
		expect(results.map((r) => r.ok)).toEqual([false, false]);
		expect(questions.map((q) => q.command)).toEqual([`write ${join(outside, "x.txt")}`]);
		expect(await text(join(cwd, "settings", "sandbox.json"))).toBe("{}");
		expect(await text(join(outside, "x.txt"))).toBe("old\n");
	});

	it("refuses a dangling link without asking, keeping the link", async () => {
		const { lstat } = await import("node:fs/promises");
		const target = join(outside, "fresh.txt");
		await symlink(target, join(cwd, "dangling"));
		await symlink("missing-dir", join(cwd, "dir-link"));
		const { questions, results } = await run([writeCall("dangling", "w1"), writeCall("dir-link/f.txt", "w2")]);
		expect(questions).toEqual([]);
		expect(results).toEqual([
			{ ok: false, output: "Not written: dangling is a symbolic link to a missing file." },
			{ ok: false, output: "Not written: dir-link/f.txt is a symbolic link to a missing file." },
		]);
		expect((await lstat(join(cwd, "dangling"))).isSymbolicLink()).toBe(true);
		expect(await exists(target)).toBe(false);
		expect(await exists(join(cwd, "missing-dir"))).toBe(false);
	});

	it("does not redirect an approved outside write into another allowed file", async () => {
		const { unlink } = await import("node:fs/promises");
		await symlink(join(outside, "x.txt"), join(cwd, "swap"));
		const { results } = await run([writeCall("swap", "w1")], {
			approve: async () => {
				await unlink(join(cwd, "swap"));
				await symlink(join(cwd, "inside.txt"), join(cwd, "swap"));
				return true;
			},
		});
		expect(results[0]?.ok).toBe(false);
		expect(await text(join(cwd, "inside.txt"))).toBe("old\n");
		expect(await text(join(outside, "x.txt"))).toBe("old\n");
	});

	it("refuses a feature document whose basename begins with two dots through an alias", async () => {
		const { rename } = await import("node:fs/promises");
		const docs = join(outside, "docs");
		await rename(join(cwd, "odd", "tasks"), docs);
		await symlink(docs, join(cwd, "odd", "tasks"));
		await symlink(docs, join(cwd, "docs"));
		await writeFile(join(docs, "..draft.md"), "old\n");
		const path = "docs/..draft.md";
		const { questions, results } = await run([writeCall(path, "w1")]);
		expect(questions).toEqual([]);
		expect(results).toEqual([
			{ ok: false, output: `${path} is a feature document: change it with the feature tool, not write.` },
		]);
		expect(await text(join(docs, "..draft.md"))).toBe("old\n");
	});

	it.each([".git/config", ".git/hooks/post-checkout"])("refuses creating the sandbox-protected %s", async (path) => {
		const { questions, results } = await run([writeCall(path, "w1", "[core]\n fsmonitor = ./monitor\n")]);
		expect(questions).toEqual([]);
		expect(results[0]?.ok).toBe(false);
		expect(await exists(join(cwd, ".git"))).toBe(false);
	});

	it("accepts exactly one MiB of multibyte UTF-8", async () => {
		const content = "é".repeat(MAX_WRITE_BYTES / 2);
		const { results } = await run([writeCall("utf8.txt", "w1", content)]);
		expect(results).toEqual([{ ok: true, output: "Wrote utf8.txt (1048576 bytes)." }]);
		expect(await text(join(cwd, "utf8.txt"))).toBe(content);
	});
});

// S2 / D1, D2, D5: independent round-two regressions.
describe("write: APFS missing-path protections", () => {
	it.each([
		["Settings", "sETTINGS"],
		["café", "cafe\u0301"],
	])("refuses the missing real configuration through %s / %s", async (target, alias) => {
		const { createHash } = await import("node:crypto");
		const { rename } = await import("node:fs/promises");
		await rename(join(cwd, ".atelier"), join(cwd, "saved-settings"));
		await symlink(target, join(cwd, ".atelier"));
		const path = `${alias}/sandbox.json`;
		const hash = () => text(join(outside, "x.txt")).then((value) => createHash("sha256").update(value).digest("hex"));
		const before = await hash();
		const { questions, results } = await run(
			[
				writeCall(path, "r2-config", JSON.stringify({ allowWrite: [outside] })),
				writeCall(join(outside, "x.txt"), "r2-outside"),
			],
			{ answer: false },
		);
		expect(results[0]).toEqual({
			ok: false,
			output: `${path} is project configuration: the agent does not write .atelier/.`,
		});
		expect(questions.map((q) => q.command)).toEqual([`write ${join(outside, "x.txt")}`]);
		expect(await exists(join(cwd, target))).toBe(false);
		expect(await hash()).toBe(before);
	});

	it("refuses a dangling link into a missing case alias of a secret directory (the dangling-link refusal fires first)", async () => {
		const { lstat } = await import("node:fs/promises");
		await symlink(join(home, ".AWS", "new"), join(cwd, "secret-link"));
		const { questions, results } = await run([writeCall("secret-link", "r2-secret")]);
		expect(questions).toEqual([]);
		expect(results).toEqual([{ ok: false, output: "Not written: secret-link is a symbolic link to a missing file." }]);
		expect(await exists(join(home, ".aws"))).toBe(false);
		expect((await lstat(join(cwd, "secret-link"))).isSymbolicLink()).toBe(true);
	});

	it("refuses a missing git config through a case alias", async () => {
		await mkdir(join(cwd, ".git"));
		const { questions, results } = await run([writeCall(".git/CONFIG", "r2-git")]);
		expect(questions).toEqual([]);
		expect(results).toEqual([
			{ ok: false, output: ".git/CONFIG is git state that runs code: the agent does not write it." },
		]);
		expect(await exists(join(cwd, ".git", "config"))).toBe(false);
	});
});

describe("who has write", () => {
	it("is in the main agent's tools and the worker's, not the explorer's", () => {
		expect(coreTools.map((tool) => tool.name)).toEqual(["read", "edit", "write", "bash", "grep", "web_fetch"]);
		const tools = Object.fromEntries(BUILTIN_AGENTS.map((agent) => [agent.name, agent.tools]));
		expect(tools.worker).toEqual(["read", "edit", "write", "grep", "bash", "web_fetch"]);
		expect(tools.explorer).toEqual(["read", "grep", "web_fetch"]);
	});

	it("describes itself next to edit", () => {
		const description = createWriteTool({ home }).description;
		expect(description).toContain("edit");
		expect(description).toContain("replace it entirely");
	});
});
