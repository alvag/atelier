import { spawnSync } from "node:child_process";
import {
	appendFile,
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AtelierEvent,
	type AtelierEventBody,
	defineTool,
	FakeBackend,
	type FakeStep,
	folderKey,
	Session,
	type SessionOptions,
	SessionStore,
} from "../src/index.ts";
import { LEFT_YOLO } from "../src/prompt.ts";
import type { SessionRecorder } from "../src/sessions/index.ts";

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };
const text = (value: string): FakeStep => ({ event: { type: "text_delta", text: value } });

let home: string;
let cwd: string;
beforeEach(async () => {
	home = await realpath(await mkdtemp(join(tmpdir(), "atelier-saved-home-")));
	cwd = await realpath(await mkdtemp(join(tmpdir(), "atelier-saved-cwd-")));
});
afterEach(async () => {
	await rm(home, { recursive: true, force: true });
	await rm(cwd, { recursive: true, force: true });
});

async function drain(session: Session, prompt = "go"): Promise<AtelierEvent[]> {
	const events: AtelierEvent[] = [];
	for await (const event of session.send(prompt)) events.push(event);
	return events;
}

/** The lines of a session file, parsed. */
async function linesOf(path: string): Promise<Record<string, unknown>[]> {
	const content = await readFile(path, "utf8");
	return content
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line));
}

/** What a recorded line is, for reading a sequence: an event by its own type. */
const kind = (line: Record<string, unknown>) =>
	line.type === "event" ? `event:${(line.event as { type: string }).type}` : String(line.type);

async function started(turns: FakeStep[][], options: Partial<SessionOptions> = {}) {
	const store = new SessionStore(home);
	const record = store.create(cwd);
	const backend = new FakeBackend(turns, "claude-code");
	const session = await Session.start({ backend, cwd, tools: [], record, ...options });
	return { store, record, backend, session };
}

/** A saved session written by hand, one entry at a time, for the readers to take. */
async function writeSession(id: string, lines: unknown[], folderOf = cwd) {
	const store = new SessionStore(home);
	const path = store.path(folderOf, id);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, lines.map((line) => `${typeof line === "string" ? line : JSON.stringify(line)}\n`).join(""));
	return path;
}

const header = (id: string, extra: Record<string, unknown> = {}) => ({
	kind: "atelier.session",
	version: 1,
	id,
	cwd,
	createdAt: "2026-01-01T00:00:00.000Z",
	...extra,
});
const config = { type: "config", backend: "claude-code", mode: "normal" };

describe("recording a session", () => {
	it("writes a file under the folder's key with a header, the configuration, the prompt, the events and the state", async () => {
		const { record, backend, session } = await started([
			[
				{ event: { type: "session_started", backend: "claude-code", model: "m", authSource: "api_key" } },
				{ event: { type: "thinking_delta", text: "hmm" } },
				text("Hel"),
				text("lo"),
				{ toolCall: { tool: "nope", input: {}, callId: "c1" } },
				text("done"),
				{ event: finished },
			],
		]);
		backend.resumeState = { sessionId: "claude-1" };
		await drain(session, "say hello");
		await session.close();

		expect(record.path).toBe(join(home, ".atelier", "sessions", folderKey(cwd), `${record.id}.jsonl`));
		expect(folderKey("/Users/a/my project")).toBe("--Users-a-my project--");
		const lines = await linesOf(record.path);
		expect(lines[0]).toEqual({
			kind: "atelier.session",
			version: 1,
			id: record.id,
			cwd,
			createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
		});
		expect(lines.slice(1).map(kind)).toEqual([
			"config",
			"prompt",
			"event:session_started",
			"text",
			"event:tool_call_started",
			"event:tool_call_finished",
			"text",
			"state",
			"event:turn_finished",
		]);
		expect(lines[1]).toEqual({ type: "config", backend: "claude-code", mode: "normal" });
		expect(lines[2]).toMatchObject({ type: "prompt", text: "say hello" });
		expect(lines[4]).toMatchObject({ type: "text", text: "Hello" });
		expect(lines[7]).toMatchObject({ type: "text", text: "done" });
		expect(lines[8]).toEqual({ type: "state", backend: "claude-code", sessionId: "claude-1", yoloTold: false });
		// Thinking is not kept.
		expect(JSON.stringify(lines)).not.toContain("hmm");
	});

	it("records the configuration changes of a turn and the mode as it was announced", async () => {
		const { record, session } = await started([[{ event: finished }], [{ event: finished }]], { model: "opus" });
		await drain(session);
		session.setPermissionMode("yolo");
		await session.configure({ model: "sonnet", thinking: "high" });
		await drain(session);
		await session.close();
		const configs = (await linesOf(record.path)).filter((line) => line.type === "config");
		expect(configs).toEqual([
			{ type: "config", backend: "claude-code", model: "opus", mode: "normal" },
			{ type: "config", backend: "claude-code", model: "sonnet", thinking: "high", mode: "yolo" },
		]);
	});

	it("writes nothing for a session without a recorder, and asks its backend to keep nothing", async () => {
		const backend = new FakeBackend([[{ event: finished }]], "claude-code");
		const session = await Session.start({ backend, cwd, tools: [] });
		await drain(session);
		await session.close();
		expect(backend.startOptions).not.toHaveProperty("persist");
		expect(await readdir(home)).toEqual([]);
	});

	it("asks the backend to keep what it needs to resume when the session is saved", async () => {
		const { backend, session } = await started([]);
		await session.close();
		expect(backend.startOptions?.persist).toBe(true);
	});

	it("does not create the file before the first turn", async () => {
		const { record, session } = await started([]);
		await session.close();
		await expect(stat(record.path)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("says once, in the next turn, that the session could not be saved, and goes on", async () => {
		const blocker = join(home, "blocker");
		await writeFile(blocker, "a file where a folder should be");
		const store = new SessionStore(blocker);
		const backend = new FakeBackend(
			[[text("one"), { event: finished }], [text("two"), { event: finished }], [{ event: finished }]],
			"claude-code",
		);
		const session = await Session.start({ backend, cwd, tools: [], record: store.create(cwd) });
		const first = await drain(session);
		const second = await drain(session);
		const third = await drain(session);
		await session.close();
		expect(first.some((event) => event.type === "error")).toBe(false);
		expect(second.filter((event) => event.type === "error")).toEqual([
			expect.objectContaining({ code: "session_not_saved", recoverable: true }),
		]);
		expect(third.some((event) => event.type === "error")).toBe(false);
		expect(first.some((event) => event.type === "text_delta")).toBe(true);
	});
});

describe("the backend state", () => {
	it("appends the messages a turn added and writes the whole history when it no longer starts with the saved one", async () => {
		const { record, backend, session } = await started([
			[{ event: finished }],
			[{ event: finished }],
			[{ event: finished }],
			[{ event: finished }],
		]);
		const user = (value: string) => ({ role: "user", content: value });
		const assistant = (value: string) => ({ role: "assistant", content: [{ type: "text", text: value }] });
		backend.resumeState = { messages: [user("a"), assistant("b")] };
		await drain(session);
		backend.resumeState = { messages: [user("a"), assistant("b"), user("c"), assistant("d")] };
		await drain(session);
		// A turn that changed nothing writes nothing.
		await drain(session);
		// A compaction replaced the beginning.
		backend.resumeState = { messages: [user("summary"), user("c"), assistant("d")] };
		await drain(session);
		await session.close();
		const states = (await linesOf(record.path)).filter((line) => line.type === "state");
		expect(states).toEqual([
			{ type: "state", backend: "claude-code", messages: [user("a"), assistant("b")], replace: false, yoloTold: false },
			{ type: "state", backend: "claude-code", messages: [user("c"), assistant("d")], replace: false },
			{ type: "state", backend: "claude-code", messages: [user("summary"), user("c"), assistant("d")], replace: true },
		]);
		const loaded = await new SessionStore(home).load(cwd, record.id);
		expect(loaded.resume).toEqual({ messages: [user("summary"), user("c"), assistant("d")] });
	});

	it("writes what the model was last told about yolo when it changes, even when the backend state did not", async () => {
		const turns = Array.from({ length: 4 }, (): FakeStep[] => [{ event: finished }]);
		const { record, backend, session } = await started(turns);
		backend.resumeState = { sessionId: "cc-1" };
		await drain(session, "plain");
		session.setPermissionMode("yolo");
		await drain(session, "in yolo");
		session.setPermissionMode("normal");
		await drain(session, "out of it");
		await drain(session, "nothing new");
		await session.close();
		const states = (await linesOf(record.path)).filter((line) => line.type === "state");
		expect(states).toEqual([
			{ type: "state", backend: "claude-code", sessionId: "cc-1", yoloTold: false },
			{ type: "state", backend: "claude-code", sessionId: "cc-1", yoloTold: true },
			{ type: "state", backend: "claude-code", sessionId: "cc-1", yoloTold: false },
		]);
		const store = new SessionStore(home);
		expect((await store.load(cwd, record.id)).yoloTold).toBe(false);

		// A later state without the field keeps what an earlier one said; a file without it says nothing.
		const id = "told";
		await writeSession(id, [
			header(id),
			config,
			{ type: "state", backend: "claude-code", sessionId: "cc-1", yoloTold: true },
			{ type: "state", backend: "claude-code", sessionId: "cc-2" },
		]);
		expect((await store.load(cwd, id)).yoloTold).toBe(true);
		await writeSession("old", [header("old"), config, { type: "state", backend: "claude-code", sessionId: "cc-1" }]);
		expect(await store.load(cwd, "old")).not.toHaveProperty("yoloTold");
		await writeSession("bad", [
			header("bad"),
			config,
			{ type: "state", backend: "claude-code", sessionId: "x", yoloTold: "yes" },
		]);
		await expect(store.load(cwd, "bad")).rejects.toMatchObject({ code: "corrupt" });
	});

	it("saves the yolo rules as told when the model took them with a tool call and the turn then failed", async () => {
		const read = defineTool({
			name: "read",
			description: "read",
			inputShape: {},
			execute: async () => ({ ok: true, output: "", summary: "read", truncated: false }),
		});
		const toolThenError: FakeStep[] = [
			{ toolCall: { tool: "read", input: {}, callId: "c1" } },
			{ throw: "second model request failed" },
		];
		const { record, backend, session } = await started([toolThenError], { tools: [read] });
		backend.resumeState = { sessionId: "cc-1" };
		session.setPermissionMode("yolo");
		await drain(session, "first");
		await session.close();
		expect((await new SessionStore(home).load(cwd, record.id)).yoloTold).toBe(true);
	});

	it("saves that it is unknown whether the model saw a note the backend rejected, and resumes saying the mode", async () => {
		const { store, record, backend, session } = await started([[{ throw: "overloaded before output" }]]);
		backend.resumeState = { sessionId: "cc-1" };
		session.setPermissionMode("yolo");
		await drain(session, "first");
		await session.close();
		const loaded = await store.load(cwd, record.id);
		expect(loaded.yoloTold).toBeNull();

		const next = new FakeBackend([[{ event: finished }]], "claude-code");
		const resumed = await Session.start({
			backend: next,
			cwd,
			tools: [],
			permissionMode: "normal",
			...(loaded.resume === undefined ? {} : { resume: loaded.resume }),
			...(loaded.yoloTold === undefined ? {} : { resumedYoloTold: loaded.yoloTold }),
		});
		await drain(resumed, "go");
		await resumed.close();
		expect(next.prompts).toEqual([`${LEFT_YOLO}\n\ngo`]);
	});

	it("resumes with the configuration of the backend that wrote the state", async () => {
		const id = "switched";
		await writeSession(id, [
			header(id),
			{ ...config, model: "opus" },
			{ type: "prompt", turnId: "t", text: "hi" },
			{ type: "state", backend: "claude-code", sessionId: "cc-1" },
			// A backend change whose turn never finished.
			{ type: "config", backend: "anthropic-api", mode: "yolo" },
		]);
		const loaded = await new SessionStore(home).load(cwd, id);
		expect(loaded.config).toEqual({ backend: "claude-code", model: "opus", mode: "normal" });
		expect(loaded.resume).toEqual({ sessionId: "cc-1" });
	});
});

describe("reading a session", () => {
	it("ignores a last line a crash cut short, and the next writer drops it", async () => {
		const { store, record, session } = await started([[text("ok"), { event: finished }]]);
		await drain(session, "first");
		await session.close();
		const before = await readFile(record.path, "utf8");
		await appendFile(record.path, '{"type":"prompt","turnId":"t9","te');

		const [info] = await store.list(cwd);
		expect(info).toMatchObject({ id: record.id, turns: 1, lastPrompt: "first", resumable: true });
		const loaded = await store.load(cwd, record.id);
		expect(loaded.turns).toBe(1);

		await store.rename(cwd, record.id, "after the crash");
		const lines = await linesOf(record.path);
		expect(lines.at(-1)).toEqual({ type: "name", name: "after the crash" });
		expect(await readFile(record.path, "utf8")).toBe(`${before}{"type":"name","name":"after the crash"}\n`);
	});

	it("keeps a last line that only lacks its newline", async () => {
		const id = "nonewline";
		const path = await writeSession(id, [header(id), config]);
		await appendFile(path, JSON.stringify({ type: "prompt", turnId: "t", text: "kept" }));
		const store = new SessionStore(home);
		expect((await store.load(cwd, id)).turns).toBe(1);
		await store.rename(cwd, id, "n");
		expect((await linesOf(path)).map(kind)).toEqual(["undefined", "config", "prompt", "name"]);
	});

	it("rejects a line that is not JSON anywhere but at the end, and lists the file with the reason", async () => {
		const id = "broken";
		await writeSession(id, [header(id), config, "{not json", { type: "prompt", turnId: "t", text: "x" }]);
		const store = new SessionStore(home);
		await expect(store.load(cwd, id)).rejects.toMatchObject({
			code: "corrupt",
			message: expect.stringContaining("line 3"),
		});
		expect(await store.list(cwd)).toEqual([
			expect.objectContaining({ id, resumable: false, problem: "line 3 is not valid JSON", turns: 0 }),
		]);
	});

	it("rejects an entry of a known type that lacks what it needs, a header that is not ours, and a file without configuration", async () => {
		const store = new SessionStore(home);
		await writeSession("badentry", [header("badentry"), { type: "config", backend: "nope", mode: "normal" }]);
		await expect(store.load(cwd, "badentry")).rejects.toMatchObject({ code: "corrupt" });
		await writeSession("foreign", [{ kind: "something.else", version: 1 }]);
		await expect(store.load(cwd, "foreign")).rejects.toMatchObject({ code: "corrupt" });
		await writeSession("noconfig", [header("noconfig"), { type: "prompt", turnId: "t", text: "x" }]);
		await expect(store.load(cwd, "noconfig")).rejects.toMatchObject({
			code: "corrupt",
			message: expect.stringContaining("no configuration"),
		});
		await writeSession("renamed", [header("other-id"), config]);
		await expect(store.load(cwd, "renamed")).rejects.toMatchObject({ code: "corrupt" });
	});

	it("lists a file with an unknown version and does not resume it, leaving it as it is", async () => {
		const id = "future";
		const path = await writeSession(id, [header(id, { version: 2 }), { type: "anything", new: true }]);
		const before = await readFile(path, "utf8");
		const store = new SessionStore(home);
		const [info] = await store.list(cwd);
		expect(info).toEqual({
			id,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: expect.any(String),
			turns: 0,
			resumable: false,
			problem: "it was saved with session format version 2, and this Atelier reads version 1",
		});
		await expect(store.load(cwd, id)).rejects.toMatchObject({
			code: "unsupported_version",
			message: expect.stringContaining("version 2"),
		});
		await expect(store.rename(cwd, id, "x")).rejects.toMatchObject({ code: "unsupported_version" });
		expect(await readFile(path, "utf8")).toBe(before);
	});

	it("skips entry types a later version of the same format adds", async () => {
		const id = "newer-entry";
		await writeSession(id, [
			header(id),
			config,
			{ type: "bookmark", at: 1 },
			{ type: "prompt", turnId: "t", text: "x" },
		]);
		const loaded = await new SessionStore(home).load(cwd, id);
		expect(loaded.entries.map((entry) => entry.type)).toEqual(["config", "prompt"]);
	});
});

describe("listing sessions", () => {
	it("lists the newest first with their fields, one line for the last prompt", async () => {
		const store = new SessionStore(home);
		const make = async (prompts: string[], model: string | undefined, mtime: number, name?: string) => {
			const record = store.create(cwd, name === undefined ? {} : { name });
			record.config({ backend: "anthropic-api", mode: "auto", ...(model === undefined ? {} : { model }) });
			for (const [index, prompt] of prompts.entries()) record.prompt(`t${index}`, prompt);
			await record.flush();
			await utimes(record.path, mtime, mtime);
			return record.id;
		};
		const oldest = await make(["a"], "claude-opus-5-5", 1_700_000_000);
		const newest = await make(
			["one", `line one\n\n   line two ${"x".repeat(200)}`],
			undefined,
			1_800_000_000,
			"named at start",
		);
		const middle = await make([], "claude-haiku-5-5", 1_750_000_000);
		const listed = await store.list(cwd);
		expect(listed.map((info) => info.id)).toEqual([newest, middle, oldest]);
		expect(listed[0]).toEqual({
			id: newest,
			name: "named at start",
			createdAt: expect.any(String),
			updatedAt: new Date(1_800_000_000_000).toISOString(),
			turns: 2,
			lastPrompt: `line one line two ${"x".repeat(80 - "line one line two ".length - 1)}…`,
			backend: "anthropic-api",
			resumable: true,
		});
		expect(listed[0]?.lastPrompt).toHaveLength(80);
		expect(listed[1]).toMatchObject({ turns: 0, model: "claude-haiku-5-5", resumable: true });
		expect(listed[1]).not.toHaveProperty("lastPrompt");
		expect(listed[2]).toMatchObject({ turns: 1, lastPrompt: "a", backend: "anthropic-api", model: "claude-opus-5-5" });
	});

	it("lists an empty folder as nothing, and keeps the sessions of another folder apart", async () => {
		const store = new SessionStore(home);
		expect(await store.list(cwd)).toEqual([]);
		const other = join(cwd, "other");
		const record = store.create(other);
		record.config({ backend: "claude-code", mode: "normal" });
		await record.flush();
		expect(await store.list(cwd)).toEqual([]);
		expect(await store.list(other)).toHaveLength(1);
	});

	it("does not mix two folders whose paths encode to the same key", async () => {
		const store = new SessionStore(home);
		const dashed = join(cwd, "a-b");
		const nested = join(cwd, "a", "b");
		expect(folderKey(dashed)).toBe(folderKey(nested));
		const one = store.create(dashed);
		one.config({ backend: "claude-code", mode: "normal" });
		await one.flush();
		expect((await store.list(dashed)).map((info) => info.id)).toEqual([one.id]);
		expect(await store.list(nested)).toEqual([]);
		await expect(store.load(nested, one.id)).rejects.toMatchObject({ code: "not_found" });
		await expect(store.delete(nested, one.id)).rejects.toMatchObject({ code: "not_found" });
		expect(await store.list(dashed)).toHaveLength(1);
	});

	it("keeps a very long folder name within a file name", async () => {
		const long = join("/", ...Array.from({ length: 12 }, () => "d".repeat(60)));
		const key = folderKey(long);
		expect(key.length).toBeLessThan(255);
		expect(folderKey(long)).toBe(key);
		expect(folderKey(`${long}x`)).not.toBe(key);
	});
});

describe("renaming and deleting", () => {
	it("appends the name and shows it in the list, without touching what was written", async () => {
		const { store, record, session } = await started([[{ event: finished }]]);
		await drain(session);
		await session.close();
		const before = await readFile(record.path, "utf8");
		await store.rename(cwd, record.id, "  the parser fix  ");
		await store.rename(cwd, record.id, "the parser fix, again");
		expect((await readFile(record.path, "utf8")).startsWith(before)).toBe(true);
		expect((await store.list(cwd))[0]?.name).toBe("the parser fix, again");
		expect((await store.load(cwd, record.id)).name).toBe("the parser fix, again");
	});

	it("refuses an empty or too long name and a session that does not exist", async () => {
		const { store, record, session } = await started([[{ event: finished }]]);
		await drain(session);
		await session.close();
		await expect(store.rename(cwd, record.id, "   ")).rejects.toMatchObject({ code: "invalid_name" });
		await expect(store.rename(cwd, record.id, "x".repeat(201))).rejects.toMatchObject({ code: "invalid_name" });
		await expect(store.rename(cwd, "missing", "x")).rejects.toMatchObject({ code: "not_found" });
	});

	it("deletes only the file asked for", async () => {
		const store = new SessionStore(home);
		const make = async () => {
			const record = store.create(cwd);
			record.config({ backend: "claude-code", mode: "normal" });
			await record.flush();
			return record;
		};
		const [one, two] = [await make(), await make()];
		await store.delete(cwd, one.id);
		expect((await store.list(cwd)).map((info) => info.id)).toEqual([two.id]);
		await expect(store.delete(cwd, one.id)).rejects.toMatchObject({ code: "not_found" });
		await expect(stat(two.path)).resolves.toBeDefined();
	});

	it("never leaves the folder with an id that is a path", async () => {
		const store = new SessionStore(home);
		for (const id of ["../x", "a/b", "..", ""]) {
			await expect(store.load(cwd, id)).rejects.toMatchObject({ code: "not_found" });
			await expect(store.delete(cwd, id)).rejects.toMatchObject({ code: "not_found" });
		}
	});
});

describe("resuming into a session", () => {
	it("starts the backend with the saved state and goes on writing the same file", async () => {
		const first = await started([[text("one"), { event: finished }]]);
		first.backend.resumeState = {
			messages: [
				{ role: "user", content: "first" },
				{ role: "assistant", content: [{ type: "text", text: "one" }] },
			],
		};
		await drain(first.session, "first");
		await first.session.close();

		const store = new SessionStore(home);
		const loaded = await store.load(cwd, first.record.id);
		const backend = new FakeBackend([[text("two"), { event: finished }]], "claude-code");
		const session = await Session.start({
			backend,
			cwd,
			tools: [],
			record: store.continue(cwd, loaded),
			...(loaded.resume === undefined ? {} : { resume: loaded.resume }),
		});
		expect(backend.startOptions?.resume).toEqual(first.backend.resumeState);
		backend.resumeState = {
			messages: [
				{ role: "user", content: "first" },
				{ role: "assistant", content: [{ type: "text", text: "one" }] },
				{ role: "user", content: "second" },
				{ role: "assistant", content: [{ type: "text", text: "two" }] },
			],
		};
		await drain(session, "second");
		await session.close();

		const lines = await linesOf(first.record.path);
		expect(lines.filter((line) => line.kind === "atelier.session")).toHaveLength(1);
		expect(lines.filter((line) => line.type === "prompt").map((line) => line.text)).toEqual(["first", "second"]);
		// The second state follows the first: the history is not written twice.
		const states = lines.filter((line) => line.type === "state");
		expect(states.map((line) => (line.messages as unknown[]).length)).toEqual([2, 2]);
		expect(states[1]?.replace).toBe(false);
		expect(await store.list(cwd)).toHaveLength(1);
	});

	it("starts empty with the saved configuration when no turn ever finished", async () => {
		const id = "unfinished";
		await writeSession(id, [
			header(id),
			{ ...config, model: "opus", thinking: "high" },
			{ type: "prompt", turnId: "t", text: "lost" },
		]);
		const loaded = await new SessionStore(home).load(cwd, id);
		expect(loaded.config).toEqual({ backend: "claude-code", model: "opus", thinking: "high", mode: "normal" });
		expect(loaded.resume).toBeUndefined();
		expect(loaded.turns).toBe(1);
	});

	it("gives back the transcript without the backend state", async () => {
		const { record, backend, session } = await started([[text("a"), { event: finished }]]);
		backend.resumeState = { sessionId: "s" };
		await drain(session, "q");
		await session.close();
		const loaded = await new SessionStore(home).load(cwd, record.id);
		expect(loaded.entries.map((entry) => entry.type)).toEqual(["config", "prompt", "text", "event"]);
		expect(loaded.entries.at(-1)).toMatchObject({ type: "event", event: { type: "turn_finished" } });
	});
});

describe("who can read a session file", () => {
	const modeOf = async (path: string) => (await stat(path)).mode & 0o777;
	const root = () => join(home, ".atelier", "sessions");

	it("creates the folders for their owner alone and the file with 0600", async () => {
		const { record, session } = await started([[{ event: finished }]]);
		await drain(session);
		await session.close();
		expect(await modeOf(record.path)).toBe(0o600);
		expect(await modeOf(dirname(record.path))).toBe(0o700);
		expect(await modeOf(root())).toBe(0o700);
	});

	it("tightens a folder and a file that are looser when it opens them", async () => {
		const id = "loose";
		const path = await writeSession(id, [header(id), config]);
		await chmod(path, 0o644);
		await chmod(dirname(path), 0o755);
		await chmod(root(), 0o755);
		await new SessionStore(home).rename(cwd, id, "private");
		expect(await modeOf(path)).toBe(0o600);
		expect(await modeOf(dirname(path))).toBe(0o700);
		expect(await modeOf(root())).toBe(0o700);
	});
});

describe("a write that fails", () => {
	const user = (value: string) => ({ role: "user", content: value });

	it("leaves the history to be written in full at the next turn", async () => {
		const store = new SessionStore(home);
		const record = store.create(cwd);
		record.config({ backend: "anthropic-api", mode: "normal" });
		record.state("anthropic-api", { messages: [user("a")] });
		await record.flush();
		await chmod(record.path, 0o400);
		record.state("anthropic-api", { messages: [user("a"), user("b")] });
		await record.flush();
		expect(record.takeFailure()).toEqual(expect.any(String));
		await chmod(record.path, 0o600);
		record.state("anthropic-api", { messages: [user("a"), user("b"), user("c")] });
		await record.flush();
		expect(record.takeFailure()).toBeUndefined();
		const states = (await linesOf(record.path)).filter((line) => line.type === "state");
		expect(states.map((line) => line.messages)).toEqual([[user("a")], [user("b"), user("c")]]);
	});

	it("leaves the Claude Code session id to be written at the next turn", async () => {
		const record = new SessionStore(home).create(cwd);
		record.config({ backend: "claude-code", mode: "normal" });
		record.state("claude-code", { sessionId: "cc-1" });
		await record.flush();
		await chmod(record.path, 0o400);
		record.state("claude-code", { sessionId: "cc-2" });
		await record.flush();
		expect(record.takeFailure()).toEqual(expect.any(String));
		await chmod(record.path, 0o600);
		record.state("claude-code", { sessionId: "cc-2" });
		await record.flush();
		const states = (await linesOf(record.path)).filter((line) => line.type === "state");
		expect(states.map((line) => line.sessionId)).toEqual(["cc-1", "cc-2"]);
	});
});

describe("the state of a session after a backend change", () => {
	it("is labeled with the backend that produced it, and a resume picks that backend", async () => {
		const { store, record, backend, session } = await started([[text("one"), { event: finished }]]);
		backend.resumeState = { sessionId: "cc-1" };
		await drain(session, "first");
		const next = new FakeBackend([[text("two"), { event: finished }]], "anthropic-api");
		await session.setBackend(next);
		next.resumeState = { messages: [{ role: "user", content: "second" }] };
		await drain(session, "second");
		await session.close();
		const states = (await linesOf(record.path)).filter((line) => line.type === "state");
		expect(states.map((line) => line.backend)).toEqual(["claude-code", "anthropic-api"]);
		const loaded = await store.load(cwd, record.id);
		expect(loaded.config.backend).toBe("anthropic-api");
		expect(loaded.resume).toEqual({ messages: [{ role: "user", content: "second" }] });
	});

	it("is labeled with the backend that ran the turn when the change was asked during it", async () => {
		const { store, record, backend, session } = await started([[{ waitForInterrupt: true }]]);
		backend.resumeState = { sessionId: "cc-1" };
		const next = new FakeBackend([[{ event: finished }]], "anthropic-api");
		const turn = drain(session, "first");
		for (let i = 0; i < 400 && !session.busy; i++) await new Promise((resolve) => setTimeout(resolve, 2));
		await session.setBackend(next);
		await session.interrupt();
		await turn;
		await session.close();
		const states = (await linesOf(record.path)).filter((line) => line.type === "state");
		expect(states.map((line) => line.backend)).toEqual(["claude-code"]);
		expect((await store.load(cwd, record.id)).resume).toEqual({ sessionId: "cc-1" });
	});
});

describe("whose file it is", () => {
	const dashed = () => join(cwd, "a-b");
	const nested = () => join(cwd, "a", "b");

	it("does not delete the unsupported-version file of another folder that shares the key", async () => {
		const id = "future";
		const path = await writeSession(id, [header(id, { version: 2, cwd: dashed() })], dashed());
		const store = new SessionStore(home);
		expect(folderKey(dashed())).toBe(folderKey(nested()));
		await expect(store.delete(nested(), id)).rejects.toMatchObject({ code: "not_found" });
		await expect(stat(path)).resolves.toBeDefined();
		expect(await store.list(nested())).toEqual([]);
		await store.delete(dashed(), id);
		await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("neither deletes nor lists a file whose header cannot be read", async () => {
		const id = "headless";
		const path = await writeSession(id, ["{not json", header(id)]);
		const store = new SessionStore(home);
		await expect(store.delete(cwd, id)).rejects.toMatchObject({ code: "not_found" });
		await expect(stat(path)).resolves.toBeDefined();
		expect(await store.list(cwd)).toEqual([]);
	});
});

describe("folder keys in bytes", () => {
	it("keeps a folder name of multibyte characters within a file name", () => {
		for (const unit of ["é", "日", "😀"]) {
			const long = join("/", unit.repeat(150));
			const key = folderKey(long);
			expect(Buffer.byteLength(key)).toBeLessThanOrEqual(255);
			expect(folderKey(long)).toBe(key);
			expect(folderKey(`${long}x`)).not.toBe(key);
			expect(key).not.toContain("\ufffd");
		}
	});

	it("keeps the hashed key of a long multibyte name within a file name", () => {
		const long = join("/", ...Array.from({ length: 12 }, () => "日".repeat(40)));
		expect(Buffer.byteLength(folderKey(long))).toBeLessThanOrEqual(255);
	});
});

describe("one writer per file", () => {
	const lockOf = (recorder: SessionRecorder) => `${recorder.path}.lock`;
	const deadPid = () => {
		const child = spawnSync(process.execPath, ["-e", ""]);
		return child.pid;
	};

	it("refuses a second writer of the same file, and lets one in once the first closes", async () => {
		const store = new SessionStore(home);
		const first = store.create(cwd);
		first.config({ backend: "claude-code", mode: "normal" });
		await first.flush();
		const loaded = await store.load(cwd, first.id);
		await first.lock();
		expect((await readFile(lockOf(first), "utf8")).trim()).toBe(String(process.pid));
		expect((await stat(lockOf(first))).mode & 0o777).toBe(0o600);
		const second = store.continue(cwd, loaded);
		await expect(second.lock()).rejects.toMatchObject({
			code: "session_in_use",
			message: expect.stringContaining(`pid ${process.pid}`),
		});
		await first.release();
		await expect(stat(lockOf(first))).rejects.toMatchObject({ code: "ENOENT" });
		await second.lock();
		await second.release();
	});

	it("takes over the lock of a process that is gone", async () => {
		const store = new SessionStore(home);
		const first = store.create(cwd);
		first.config({ backend: "claude-code", mode: "normal" });
		await first.flush();
		await writeFile(lockOf(first), `${deadPid()}\n`);
		await first.lock();
		expect((await readFile(lockOf(first), "utf8")).trim()).toBe(String(process.pid));
		await first.release();
	});

	it("is released when the session closes, and does not show as a session", async () => {
		const { store, record, session } = await started([[{ event: finished }]]);
		await record.lock();
		await drain(session);
		expect((await store.list(cwd)).map((info) => info.id)).toEqual([record.id]);
		await session.close();
		await expect(stat(lockOf(record))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("is released when the process exits", async () => {
		const store = new SessionStore(home);
		const recorder = store.create(cwd);
		const source = fileURLToPath(new URL("../src/sessions/index.ts", import.meta.url));
		const script = `import { SessionStore } from ${JSON.stringify(source)};
const recorder = new SessionStore(${JSON.stringify(home)}).create(${JSON.stringify(cwd)});
await recorder.lock();
console.log(recorder.path);
process.exit(0);`;
		const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
		expect(child.status).toBe(0);
		const path = child.stdout.trim();
		expect(path).not.toBe("");
		await expect(stat(`${path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
		expect(recorder.path).not.toBe(path);
	});
});
