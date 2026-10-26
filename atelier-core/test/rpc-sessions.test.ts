import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AtelierEventBody,
	type BackendName,
	decodeServerMessage,
	FakeBackend,
	RpcServer,
	type ServerMessage,
	SessionStore,
} from "../src/index.ts";

const finished: AtelierEventBody = {
	type: "turn_finished",
	stopReason: "end_turn",
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
};

let home: string;
let cwd: string;
beforeEach(async () => {
	home = await realpath(await mkdtemp(join(tmpdir(), "atelier-rpc-sessions-home-")));
	cwd = await realpath(await mkdtemp(join(tmpdir(), "atelier-rpc-sessions-cwd-")));
});
afterEach(async () => {
	await rm(home, { recursive: true, force: true });
	await rm(cwd, { recursive: true, force: true });
});

interface ServeOptions {
	/** The server is given no home directory. */
	noHome?: boolean;
	sessions?: boolean;
	/** Makes the backends created from now on fail to start with this message. */
	startError?: () => string | undefined;
	/** Makes the backends created fail when they are closed. */
	closeError?: string;
}

function serve(options: ServeOptions = {}) {
	const input = new PassThrough();
	const messages: ServerMessage[] = [];
	const backends: FakeBackend[] = [];
	const server = new RpcServer({
		input,
		write: (line) => messages.push(decodeServerMessage(line.trimEnd()) as ServerMessage),
		createBackend: (name: BackendName) => {
			const backend = new FakeBackend(
				[
					[{ event: { type: "text_delta", text: `answer from ${name}` } }, { event: finished }],
					[{ event: { type: "text_delta", text: "second" } }, { event: finished }],
				],
				name,
			);
			const error = options.startError?.();
			if (error !== undefined) backend.startError = error;
			if (options.closeError !== undefined) backend.closeError = options.closeError;
			backends.push(backend);
			return backend;
		},
		tools: [],
		systemPromptAppend: "",
		...(options.noHome ? {} : { home }),
		...(options.sessions === undefined ? {} : { sessions: options.sessions }),
	});
	const done = server.run();
	let next = 0;
	const ask = async (command: Record<string, unknown>) => {
		const id = `c${++next}`;
		input.write(`${JSON.stringify({ type: "command", id, ...command })}\n`);
		for (let i = 0; i < 400; i++) {
			const found = messages.find((m) => m.type === "response" && m.id === id);
			if (found) return found as Extract<ServerMessage, { type: "response" }>;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error(`No response to ${id}`);
	};
	const result = async (command: Record<string, unknown>) => {
		const response = await ask(command);
		if (!response.ok) throw new Error(`${command.command} failed: ${JSON.stringify(response.error)}`);
		// biome-ignore lint/suspicious/noExplicitAny: the tests read nested fields of answers they check right after
		return response.result as Record<string, any>;
	};
	const eventsOf = (sessionId: string) =>
		messages.flatMap((m) => (m.type === "event" && m.sessionId === sessionId ? [m.event] : []));
	const open = async (extra: Record<string, unknown> = {}) =>
		result({ command: "session.start", cwd, ...extra }) as Promise<{ sessionId: string; savedId?: string }>;
	/** Runs a turn to its end. */
	const turn = async (sessionId: string, prompt = "hi") => {
		const before = eventsOf(sessionId).filter((e) => e.type === "turn_finished").length;
		expect((await ask({ command: "session.send", sessionId, prompt })).ok).toBe(true);
		for (let i = 0; i < 400 && eventsOf(sessionId).filter((e) => e.type === "turn_finished").length === before; i++)
			await new Promise((resolve) => setTimeout(resolve, 5));
		return eventsOf(sessionId);
	};
	const close = () => {
		input.end();
		return done;
	};
	return { ask, result, open, turn, eventsOf, backends, close, messages };
}

const everything = async () => {
	const root = join(home, ".atelier", "sessions");
	const folders = await readdir(root).catch(() => []);
	return (await Promise.all(folders.map((folder) => readdir(join(root, folder))))).flat();
};
/** The session files; a running session also has a `.lock` next to its file. */
const files = async () => (await everything()).filter((name) => name.endsWith(".jsonl"));

describe("saving the sessions a server starts", () => {
	it("saves a session: its file appears with the first turn, named by the id start answers", async () => {
		const h = serve();
		const { sessionId, savedId } = await h.open();
		expect(savedId).toMatch(/^[0-9a-f-]{36}$/);
		await h.turn(sessionId);
		const listed = await h.result({ command: "sessions.list", cwd });
		expect(listed.sessions).toEqual([
			{
				id: savedId,
				createdAt: expect.any(String),
				updatedAt: expect.any(String),
				turns: 1,
				lastPrompt: "hi",
				backend: "claude-code",
				resumable: true,
			},
		]);
		expect(await files()).toEqual([`${savedId}.jsonl`]);
		expect(await everything()).toContain(`${savedId}.jsonl.lock`);
		await h.close();
		expect(await everything()).toEqual([`${savedId}.jsonl`]);
	});

	it("saves nothing for a session started with noSession", async () => {
		const h = serve();
		const started = await h.open({ noSession: true });
		expect(started).toEqual({ sessionId: expect.any(String), configuration: expect.any(Object) });
		await h.turn(started.sessionId);
		expect(await files()).toEqual([]);
		expect((await h.result({ command: "sessions.list", cwd })).sessions).toEqual([]);
		await h.close();
	});

	it("saves nothing, and says why to the session commands, when the server has no home or turns saving off", async () => {
		for (const options of [{ noHome: true }, { sessions: false }]) {
			const h = serve(options);
			const started = await h.open();
			expect(started).toEqual({ sessionId: expect.any(String), configuration: expect.any(Object) });
			await h.turn(started.sessionId);
			for (const command of [
				{ command: "sessions.list", cwd },
				{ command: "session.resume", sessionId: "abc", cwd },
				{ command: "session.rename", sessionId: "abc", cwd, name: "x" },
				{ command: "session.delete", sessionId: "abc", cwd },
			])
				expect(await h.ask(command)).toMatchObject({ ok: false, error: { code: "sessions_unavailable" } });
			await h.close();
		}
		expect(await files()).toEqual([]);
	});

	it("keeps a session started without a profile or mode on the defaults when it is resumed", async () => {
		const h = serve();
		const { sessionId, savedId } = await h.open();
		await h.turn(sessionId);
		await h.result({ command: "session.close", sessionId });
		const resumed = await h.result({ command: "session.resume", sessionId: savedId, cwd });
		expect(resumed.configuration).toMatchObject({ backend: "claude-code", permissionMode: "normal", pending: false });
		await h.close();
	});
});

describe("session.resume", () => {
	const profiles = (verifier: string) =>
		JSON.stringify({
			kind: "atelier.agent_model_profiles",
			version: 1,
			active: "p",
			profiles: { p: { verifier: { model: verifier } } },
		});

	it("restores the configuration, freezes the profile again, resumes the backend and answers the transcript", async () => {
		await mkdir(join(home, ".atelier"));
		await writeFile(join(home, ".atelier", "profiles.json"), profiles("claude-code/haiku"));
		const h = serve();
		const first = await h.open({ backend: "claude-code", model: "sonnet", mode: "auto", profile: "p" });
		const firstBackend = h.backends[0] as FakeBackend;
		firstBackend.resumeState = { sessionId: "cc-1" };
		await h.turn(first.sessionId, "list the files");
		await h.result({ command: "session.set_effort", sessionId: first.sessionId, effort: "high" });
		await h.turn(first.sessionId, "and the tests");
		await h.result({ command: "session.close", sessionId: first.sessionId });
		// The profile changed since: the resumed session takes it as it is now.
		await writeFile(join(home, ".atelier", "profiles.json"), profiles("claude-code/opus"));

		const resumed = await h.result({ command: "session.resume", sessionId: first.savedId, cwd });
		expect(resumed.sessionId).not.toBe(first.sessionId);
		expect(resumed.savedId).toBe(first.savedId);
		expect(resumed.configuration).toMatchObject({
			backend: "claude-code",
			model: "sonnet",
			thinking: "high",
			permissionMode: "auto",
			profile: { name: "p", roles: { verifier: { model: "opus" } } },
			pending: false,
		});
		const second = h.backends[1] as FakeBackend;
		expect(second.startOptions).toMatchObject({
			model: "sonnet",
			thinking: "high",
			resume: { sessionId: "cc-1" },
			persist: true,
		});
		const entries = resumed.entries as { type: string; text?: string }[];
		expect(entries.filter((entry) => entry.type === "prompt").map((entry) => entry.text)).toEqual([
			"list the files",
			"and the tests",
		]);
		expect(entries.filter((entry) => entry.type === "text").map((entry) => entry.text)).toEqual([
			"answer from claude-code",
			"second",
		]);
		expect(entries.some((entry) => entry.type === "state")).toBe(false);
		expect(resumed.createdAt).toEqual(expect.any(String));

		// The resumed session is live and goes on writing the same file.
		await h.turn(resumed.sessionId, "one more");
		const [info] = (await h.result({ command: "sessions.list", cwd })).sessions as { turns: number; id: string }[];
		expect(info).toMatchObject({ id: first.savedId, turns: 3 });
		expect(await files()).toEqual([`${first.savedId}.jsonl`]);
		await h.close();
	});

	it("resumes an anthropic-api session from its saved history", async () => {
		const h = serve();
		const first = await h.open({ backend: "anthropic-api" });
		const history = [
			{ role: "user", content: "q" },
			{ role: "assistant", content: [{ type: "text", text: "a" }] },
		];
		(h.backends[0] as FakeBackend).resumeState = { messages: history };
		await h.turn(first.sessionId, "q");
		await h.result({ command: "session.close", sessionId: first.sessionId });
		const resumed = await h.result({ command: "session.resume", sessionId: first.savedId, cwd });
		expect(resumed.configuration).toMatchObject({ backend: "anthropic-api" });
		const second = h.backends[1] as FakeBackend;
		expect(second.id).toBe("anthropic-api");
		expect(second.startOptions?.resume).toEqual({ messages: history });
		await h.close();
	});

	it("starts empty with the saved configuration when the session never finished a turn", async () => {
		const store = new SessionStore(home);
		const record = store.create(cwd);
		record.config({ backend: "anthropic-api", model: "claude-opus-5-5", mode: "yolo" });
		record.prompt("t1", "interrupted before it finished");
		await record.flush();
		const h = serve();
		const resumed = await h.result({ command: "session.resume", sessionId: record.id, cwd });
		expect(resumed.configuration).toMatchObject({
			backend: "anthropic-api",
			model: "claude-opus-5-5",
			permissionMode: "yolo",
		});
		expect(h.backends[0]?.startOptions).not.toHaveProperty("resume");
		await h.close();
	});

	it("refuses a session this server already runs, for resume and delete, until it is closed", async () => {
		const h = serve();
		const live = await h.open();
		await h.turn(live.sessionId);
		const expectInUse = { ok: false, error: { code: "session_in_use" } };
		expect(await h.ask({ command: "session.resume", sessionId: live.savedId, cwd })).toMatchObject(expectInUse);
		expect(await h.ask({ command: "session.delete", sessionId: live.savedId, cwd })).toMatchObject(expectInUse);
		// A rename only appends, so it is fine while the session runs.
		expect(await h.ask({ command: "session.rename", sessionId: live.savedId, cwd, name: "live" })).toMatchObject({
			ok: true,
		});
		await h.result({ command: "session.close", sessionId: live.sessionId });
		const again = await h.result({ command: "session.resume", sessionId: live.savedId, cwd });
		expect(again.sessionId).toEqual(expect.any(String));
		expect(again.name).toBe("live");
		await h.close();
	});

	it("lets the saved session go when closing it fails", async () => {
		const h = serve({ closeError: "the backend would not close" });
		const live = await h.open();
		await h.turn(live.sessionId);
		expect(await h.ask({ command: "session.close", sessionId: live.sessionId })).toMatchObject({ ok: false });
		const again = await h.result({ command: "session.resume", sessionId: live.savedId, cwd });
		expect(again.sessionId).toEqual(expect.any(String));
		await h.close();
	});

	it("refuses a session another process is writing, and takes it once that process lets go", async () => {
		const first = serve();
		const live = await first.open();
		await first.turn(live.sessionId);
		await first.result({ command: "session.close", sessionId: live.sessionId });
		const store = new SessionStore(home);
		const other = store.continue(cwd, await store.load(cwd, live.savedId as string));
		await other.lock();
		const second = serve();
		expect(await second.ask({ command: "session.resume", sessionId: live.savedId, cwd })).toMatchObject({
			ok: false,
			error: { code: "session_in_use", message: expect.stringContaining(`pid ${process.pid}`) },
		});
		expect(second.backends.every((backend) => backend.startOptions === undefined)).toBe(true);
		await other.release();
		const again = await second.result({ command: "session.resume", sessionId: live.savedId, cwd });
		expect(again.sessionId).toEqual(expect.any(String));
		await second.close();
		await first.close();
	});

	it("starts nothing and says so when the backend cannot resume, and the session stays resumable", async () => {
		let failure: string | undefined;
		const h = serve({ startError: () => failure });
		const first = await h.open();
		(h.backends[0] as FakeBackend).resumeState = { sessionId: "cc-lost" };
		await h.turn(first.sessionId);
		await h.result({ command: "session.close", sessionId: first.sessionId });
		const before = await readFile(join(new SessionStore(home).folder(cwd), `${first.savedId}.jsonl`), "utf8");

		failure = "Claude Code has no session cc-lost for the folder";
		const failed = await h.ask({ command: "session.resume", sessionId: first.savedId, cwd });
		expect(failed).toMatchObject({ ok: false, error: { code: "session_resume_failed" } });
		expect((failed as { error: { message: string } }).error.message).toBe(
			`Could not resume session ${first.savedId}: Claude Code has no session cc-lost for the folder`,
		);
		// Nothing was left open or marked as running, and the file is as it was.
		expect(await readFile(join(new SessionStore(home).folder(cwd), `${first.savedId}.jsonl`), "utf8")).toBe(before);
		failure = undefined;
		expect((await h.ask({ command: "session.resume", sessionId: first.savedId, cwd })).ok).toBe(true);
		await h.close();
	});

	it("answers not_found, corrupt and unsupported_version, and starts no backend", async () => {
		const store = new SessionStore(home);
		const folder = store.folder(cwd);
		await mkdir(folder, { recursive: true });
		const header = { kind: "atelier.session", version: 1, createdAt: "2026-01-01T00:00:00.000Z", cwd };
		await writeFile(join(folder, "old.jsonl"), `${JSON.stringify({ ...header, id: "old", version: 9 })}\n`);
		await writeFile(
			join(folder, "bad.jsonl"),
			`${JSON.stringify({ ...header, id: "bad" })}\nnot json\n{"type":"name","name":"x"}\n`,
		);
		const h = serve();
		expect(await h.ask({ command: "session.resume", sessionId: "missing", cwd })).toMatchObject({
			ok: false,
			error: { code: "not_found" },
		});
		expect(await h.ask({ command: "session.resume", sessionId: "old", cwd })).toMatchObject({
			ok: false,
			error: { code: "unsupported_version", message: expect.stringContaining("version 9") },
		});
		expect(await h.ask({ command: "session.resume", sessionId: "bad", cwd })).toMatchObject({
			ok: false,
			error: { code: "corrupt", message: expect.stringContaining("line 2") },
		});
		expect(h.backends).toEqual([]);
		const listed = (await h.result({ command: "sessions.list", cwd })).sessions as {
			id: string;
			resumable: boolean;
			problem?: string;
		}[];
		expect(listed.map((info) => [info.id, info.resumable]).sort()).toEqual([
			["bad", false],
			["old", false],
		]);
		await h.close();
	});
});

describe("session.rename and session.delete", () => {
	it("renames and deletes a saved session, and answers not_found for one that is not there", async () => {
		const h = serve();
		const one = await h.open();
		const two = await h.open();
		await h.turn(one.sessionId, "first session");
		await h.turn(two.sessionId, "second session");
		await h.result({ command: "session.close", sessionId: one.sessionId });
		await h.result({ command: "session.close", sessionId: two.sessionId });

		expect(await h.result({ command: "session.rename", sessionId: one.savedId, cwd, name: "  parser fix " })).toEqual(
			{},
		);
		const names = ((await h.result({ command: "sessions.list", cwd })).sessions as { id: string; name?: string }[]).map(
			(info) => [info.id, info.name],
		);
		expect(names).toContainEqual([one.savedId, "parser fix"]);
		expect(names).toContainEqual([two.savedId, undefined]);

		expect(await h.result({ command: "session.delete", sessionId: one.savedId, cwd })).toEqual({});
		expect(
			((await h.result({ command: "sessions.list", cwd })).sessions as { id: string }[]).map((info) => info.id),
		).toEqual([two.savedId]);
		expect(await files()).toEqual([`${two.savedId}.jsonl`]);

		for (const command of ["session.rename", "session.delete"])
			expect(await h.ask({ command, sessionId: one.savedId, cwd, name: "x" })).toMatchObject({
				ok: false,
				error: { code: "not_found" },
			});
		await expect(stat(new SessionStore(home).path(cwd, two.savedId as string))).resolves.toBeDefined();
		await h.close();
	});

	it("lists the sessions of each folder apart", async () => {
		const other = await realpath(await mkdtemp(join(tmpdir(), "atelier-rpc-sessions-other-")));
		try {
			const h = serve();
			const here = await h.open();
			const there = await h.open({ cwd: other });
			await h.turn(here.sessionId);
			await h.turn(there.sessionId);
			const ids = async (folder: string) =>
				((await h.result({ command: "sessions.list", cwd: folder })).sessions as { id: string }[]).map(
					(info) => info.id,
				);
			expect(await ids(cwd)).toEqual([here.savedId]);
			expect(await ids(other)).toEqual([there.savedId]);
			await h.close();
		} finally {
			await rm(other, { recursive: true, force: true });
		}
	});
});
