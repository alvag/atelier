import { chmod, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AgentBackend,
	type AtelierEvent,
	type BackendName,
	type BackendSession,
	type BackendStartOptions,
	decodeServerMessage,
	RpcServer,
	type ServerMessage,
} from "../src/index.ts";
import { parseSessionFile } from "../src/sessions/format.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };

/** Answers each prompt with a word; keeps what it was sent, and can fail or wait at a prompt. */
class ShellBackend implements AgentBackend {
	readonly id: string;
	readonly sent: string[] = [];
	readonly starts: BackendStartOptions[] = [];
	readonly messages: string[] = [];
	readonly compactions: { instructions: string | undefined; messages: string[] }[] = [];
	failNext = false;
	/** The next turn answers a word, then fails. */
	failAfterAnswer = false;
	/** The next turn ends after one thinking delta, or after one tool call, with an error. */
	failAfter: "thinking" | "tool" | undefined;
	/** While set, the next turn waits here before it says anything, until it is released or interrupted. */
	hold: { entered: () => void; release: () => void; promise: Promise<void> } | undefined;
	#held: { release: () => void } | undefined;
	/** While set, the next turn waits here after answering its first word. */
	gate: Promise<void> | undefined;
	constructor(id: string) {
		this.id = id;
	}

	async start(options: BackendStartOptions): Promise<BackendSession> {
		this.starts.push(options);
		if (options.resume && "messages" in options.resume)
			for (const message of options.resume.messages) this.messages.push(String(message));
		const backend = this;
		return {
			currentModel: () => "claude-haiku-5-5",
			async *send(prompt) {
				backend.sent.push(prompt);
				if (backend.failNext) {
					backend.failNext = false;
					throw new Error("backend down");
				}
				const hold = backend.hold;
				if (hold) {
					backend.hold = undefined;
					backend.#held = hold;
					hold.entered();
					await hold.promise;
					yield { type: "turn_finished", stopReason: "interrupted", usage };
					return;
				}
				const failAfter = backend.failAfter;
				backend.failAfter = undefined;
				if (failAfter === "thinking") yield { type: "thinking_delta", text: "hmm" };
				if (failAfter === "tool") yield { type: "tool_call_started", callId: "c", tool: "read", input: {} };
				if (failAfter) throw new Error("backend died");
				yield { type: "text_delta", text: "ok" };
				if (backend.failAfterAnswer) {
					backend.failAfterAnswer = false;
					throw new Error("backend died");
				}
				const gate = backend.gate;
				backend.gate = undefined;
				await gate;
				backend.messages.push(prompt);
				yield { type: "turn_finished", stopReason: "end_turn", usage };
			},
			async *compact(instructions) {
				backend.compactions.push({ instructions, messages: [...backend.messages] });
				yield { type: "compaction_started", reason: "manual", tokens: 100 };
				yield {
					type: "compaction_finished",
					ok: true,
					reason: "manual",
					tokensBefore: 100,
					tokensAfter: 10,
					kept: 1,
					usage,
				};
				yield { type: "turn_finished", stopReason: "end_turn", usage };
			},
			resumeState: () => ({ messages: [...backend.messages] }),
			interrupt: async () => backend.#held?.release(),
			close: async () => {},
		};
	}
}

let root: string;
let home: string;
let cwd: string;
let stop: (() => Promise<void>) | undefined;
beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "atelier-shell-result-")));
	home = join(root, "home");
	cwd = join(root, "cwd");
	await mkdir(home);
	await mkdir(cwd);
});
afterEach(async () => {
	await stop?.();
	stop = undefined;
	await rm(root, { recursive: true, force: true });
});

function serve() {
	const input = new PassThrough();
	const messages: ServerMessage[] = [];
	const backends: ShellBackend[] = [];
	const waiting: (() => void)[] = [];
	const server = new RpcServer({
		input,
		write: (line) => {
			messages.push(decodeServerMessage(line.trimEnd()) as ServerMessage);
			for (const wake of waiting.splice(0)) wake();
		},
		createBackend: (name: BackendName) => {
			const backend = new ShellBackend(name);
			backends.push(backend);
			return backend;
		},
		tools: [],
		systemPromptAppend: "",
		home,
	});
	const done = server.run();
	let next = 0;
	const until = async <T>(find: () => T | undefined): Promise<T> => {
		for (;;) {
			const found = find();
			if (found !== undefined) return found;
			await new Promise<void>((wake) => waiting.push(wake));
		}
	};
	const answer = async (command: Record<string, unknown>) => {
		const id = `c${++next}`;
		input.write(`${JSON.stringify({ type: "command", id, ...command })}\n`);
		const response = await until(() => messages.find((m) => m.type === "response" && m.id === id));
		if (response.type !== "response") throw new Error("not a response");
		return response;
	};
	const result = async (command: Record<string, unknown>) => {
		const response = await answer(command);
		if (!response.ok) throw new Error(`${command.command} failed: ${response.error.message}`);
		return response.result;
	};
	const eventsOf = (sessionId: string): AtelierEvent[] =>
		messages.flatMap((m) => (m.type === "event" && m.sessionId === sessionId ? [m.event] : []));
	const finishedTurns = (sessionId: string) => eventsOf(sessionId).filter((e) => e.type === "turn_finished").length;
	const send = async (sessionId: string, prompt: string) => {
		const before = finishedTurns(sessionId);
		const started = await result({ command: "session.send", sessionId, prompt });
		await until(() => (finishedTurns(sessionId) > before ? true : undefined));
		return started;
	};
	const compact = async (sessionId: string, instructions: string) => {
		const before = finishedTurns(sessionId);
		await result({ command: "session.compact", sessionId, instructions });
		await until(() => (finishedTurns(sessionId) > before ? true : undefined));
	};
	const open = async (backend: BackendName = "anthropic-api") => {
		const started = await result({ command: "session.start", cwd, backend, model: "claude-haiku-5-5" });
		return { sessionId: started.sessionId as string, savedId: started.savedId as string };
	};
	const shell = (sessionId: string, fields: Record<string, unknown> = {}) =>
		answer({
			command: "session.shell_result",
			sessionId,
			result: {
				executionId: "e1",
				command: "echo hi",
				excludeFromContext: false,
				output: "hi\n",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				...fields,
			},
		});
	stop = () => {
		input.end();
		return done;
	};
	return { answer, result, open, send, compact, shell, messages, backends, eventsOf, until, finishedTurns };
}

const block = (command: string, output: string, status: string) =>
	`User ran this shell command outside Atelier's sandbox:\n\n\`\`\`sh\n${command}\n\`\`\`\n\nOutput:\n\`\`\`text\n${output}\n\`\`\`\n\n${status}`;

describe("session.shell_result", () => {
	it("hands a finished result to the next prompt, before the user's words, with the exact text", async () => {
		const h = serve();
		const { sessionId } = await h.open();
		const response = await h.shell(sessionId);
		expect(response).toMatchObject({ ok: true, result: { duplicate: false } });
		expect(h.backends[0]?.sent).toEqual([]);
		await h.send(sessionId, "what now?");
		expect(h.backends[0]?.sent).toEqual([`${block("echo hi", "hi\n", "Command exited with code 0.")}\n\nwhat now?`]);
		await h.send(sessionId, "again");
		expect(h.backends[0]?.sent[1]).toBe("again");
	});

	it("never wakes a turn or emits events by itself", async () => {
		const h = serve();
		const { sessionId } = await h.open();
		await h.shell(sessionId);
		await h.shell(sessionId, { executionId: "e2", excludeFromContext: true });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(h.eventsOf(sessionId)).toEqual([]);
		expect(h.backends[0]?.sent).toEqual([]);
	});

	it("delivers several results in arrival order, and never the excluded one", async () => {
		const h = serve();
		const { sessionId } = await h.open();
		await h.shell(sessionId, { executionId: "a", command: "one", output: "1" });
		await h.shell(sessionId, { executionId: "x", command: "hidden", output: "secret", excludeFromContext: true });
		await h.shell(sessionId, { executionId: "b", command: "two", output: "" });
		await h.send(sessionId, "go");
		expect(h.backends[0]?.sent).toEqual([
			`${block("one", "1", "Command exited with code 0.")}\n\n${block("two", "(no output)", "Command exited with code 0.")}\n\ngo`,
		]);
		expect(h.backends[0]?.sent.join()).not.toContain("secret");
	});

	it("ignores a repeated execution id, before and after delivery", async () => {
		const h = serve();
		const { sessionId } = await h.open();
		await h.shell(sessionId);
		expect(await h.shell(sessionId, { output: "other" })).toMatchObject({ ok: true, result: { duplicate: true } });
		await h.send(sessionId, "go");
		expect(await h.shell(sessionId)).toMatchObject({ ok: true, result: { duplicate: true } });
		await h.send(sessionId, "next");
		expect(h.backends[0]?.sent).toEqual([`${block("echo hi", "hi\n", "Command exited with code 0.")}\n\ngo`, "next"]);
	});

	it("records concurrent duplicates once and delivers one copy", async () => {
		const h = serve();
		const { sessionId, savedId } = await h.open();
		const replies = await Promise.all([h.shell(sessionId), h.shell(sessionId), h.shell(sessionId)]);
		expect(replies.map((r) => (r.ok ? r.result.duplicate : undefined)).sort()).toEqual([false, true, true]);
		await h.send(sessionId, "go");
		expect(h.backends[0]?.sent).toEqual([`${block("echo hi", "hi\n", "Command exited with code 0.")}\n\ngo`]);
		await h.result({ command: "session.close", sessionId });
		const resumed = await h.result({ command: "session.resume", sessionId: savedId, cwd });
		const entries = resumed.entries as { type: string }[];
		expect(entries.filter((e) => e.type === "shell_result")).toHaveLength(1);
	});

	it("lets a result that could not be saved be sent again", async () => {
		const h = serve();
		const { sessionId } = await h.open();
		expect(await h.shell(sessionId, { executionId: "a", command: "one", output: "1" })).toMatchObject({ ok: true });
		const name = (await readdir(home, { recursive: true })).find((file) => file.endsWith(".jsonl"));
		expect(name).toBeDefined();
		const file = join(home, name as string);
		await chmod(file, 0o400);
		try {
			expect(await h.shell(sessionId, { executionId: "b", command: "two", output: "2" })).toMatchObject({
				ok: false,
				error: { code: "shell_not_saved" },
			});
		} finally {
			await chmod(file, 0o600);
		}
		expect(await h.shell(sessionId, { executionId: "b", command: "two", output: "2" })).toMatchObject({
			ok: true,
			result: { duplicate: false },
		});
		await h.send(sessionId, "go");
		expect(h.backends[0]?.sent).toEqual([
			`${block("one", "1", "Command exited with code 0.")}\n\n${block("two", "2", "Command exited with code 0.")}\n\ngo`,
		]);
	});

	it("accepts a result while a turn runs but keeps it out of that turn", async () => {
		const h = serve();
		const { sessionId } = await h.open();
		let release = () => {};
		const backend = h.backends[0] as ShellBackend;
		backend.gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = h.result({ command: "session.send", sessionId, prompt: "long" });
		await started;
		await h.until(() => (backend.sent.length === 1 ? true : undefined));
		expect(await h.shell(sessionId)).toMatchObject({ ok: true, result: { duplicate: false } });
		release();
		await h.until(() => (h.finishedTurns(sessionId) === 1 ? true : undefined));
		expect(backend.sent).toEqual(["long"]);
		expect(h.eventsOf(sessionId).map((e) => e.type)).not.toContain("tool_call_started");
		await h.send(sessionId, "after");
		expect(backend.sent[1]).toBe(`${block("echo hi", "hi\n", "Command exited with code 0.")}\n\nafter`);
	});

	it("keeps results pending when the backend fails before accepting the prompt", async () => {
		const h = serve();
		const { sessionId } = await h.open();
		await h.shell(sessionId, { executionId: "a", command: "one", output: "1" });
		(h.backends[0] as ShellBackend).failNext = true;
		await h.send(sessionId, "first");
		await h.shell(sessionId, { executionId: "b", command: "two", output: "2" });
		await h.send(sessionId, "second");
		const text = `${block("one", "1", "Command exited with code 0.")}\n\n${block("two", "2", "Command exited with code 0.")}`;
		expect(h.backends[0]?.sent).toEqual([
			`${block("one", "1", "Command exited with code 0.")}\n\nfirst`,
			`${text}\n\nsecond`,
		]);
	});

	it.each([
		[{ cancelled: true, exitCode: null }, "(command cancelled)"],
		[{ signal: "SIGTERM", exitCode: null }, "Command terminated by signal SIGTERM."],
		[{ error: "spawn ENOENT", exitCode: null }, "Command could not be started: spawn ENOENT."],
		[{ exitCode: 3 }, "Command exited with code 3."],
		[
			{ exitCode: 0, error: "cannot read output" },
			"Command exited with code 0.\nOutput capture failed: cannot read output.",
		],
		[
			{ cancelled: true, exitCode: null, error: "cannot read output" },
			"(command cancelled)\nOutput capture failed: cannot read output.",
		],
		[
			{ signal: "SIGKILL", exitCode: null, error: "cannot read output" },
			"Command terminated by signal SIGKILL.\nOutput capture failed: cannot read output.",
		],
		[
			{ truncated: true, fullOutputPath: "/tmp/full.log", exitCode: 1 },
			"Command exited with code 1.\n\nOutput truncated. Full output: /tmp/full.log.",
		],
	])("words the final status of %j", async (fields, status) => {
		const h = serve();
		const { sessionId } = await h.open();
		expect(await h.shell(sessionId, fields)).toMatchObject({ ok: true });
		await h.send(sessionId, "go");
		expect(h.backends[0]?.sent[0]).toBe(`${block("echo hi", "hi\n", status)}\n\ngo`);
	});

	it("widens the fences around content that holds backticks", async () => {
		const h = serve();
		const { sessionId } = await h.open();
		await h.shell(sessionId, { command: "echo '```'", output: "````x" });
		await h.send(sessionId, "go");
		expect(h.backends[0]?.sent[0]).toBe(
			"User ran this shell command outside Atelier's sandbox:\n\n````sh\necho '```'\n````\n\nOutput:\n`````text\n````x\n`````\n\nCommand exited with code 0.\n\ngo",
		);
	});

	it("keeps ordinary sessions' thinking out of the saved entries", async () => {
		const h = serve();
		const { sessionId, savedId } = await h.open();
		(h.backends[0] as ShellBackend).failAfter = "thinking";
		await h.send(sessionId, "ordinary");
		await h.result({ command: "session.close", sessionId });
		const resumed = await h.result({ command: "session.resume", sessionId: savedId, cwd });
		expect(JSON.stringify(resumed.entries)).not.toContain("thinking_delta");
		expect(JSON.stringify(resumed.entries)).not.toContain("hmm");
	});

	it("keeps the model's prompt with the ordinary raw prompt in the saved entries", async () => {
		const h = serve();
		const { sessionId, savedId } = await h.open();
		await h.shell(sessionId);
		await h.send(sessionId, "go");
		await h.result({ command: "session.close", sessionId });
		const resumed = await h.result({ command: "session.resume", sessionId: savedId, cwd });
		const entries = resumed.entries as { type: string; [key: string]: unknown }[];
		expect(entries.find((e) => e.type === "prompt")).toMatchObject({ text: "go", shellResults: ["e1"] });
		expect(entries.find((e) => e.type === "shell_result")).toMatchObject({
			result: { executionId: "e1", command: "echo hi", output: "hi\n", exitCode: 0 },
		});
	});
});

describe("session.shell_result errors", () => {
	it("refuses an unknown or closed session", async () => {
		const h = serve();
		expect(await h.shell("nope")).toMatchObject({ ok: false, error: { code: "unknown_session" } });
		const { sessionId } = await h.open();
		await h.result({ command: "session.close", sessionId });
		expect(await h.shell(sessionId)).toMatchObject({ ok: false, error: { code: "unknown_session" } });
	});

	it.each([
		["output over the byte limit", { output: "x".repeat(50 * 1024 + 1) }],
		["output over the line limit", { output: "a\n".repeat(2001) }],
		["unterminated output over the line limit", { output: `${"a\n".repeat(2000)}a` }],
		["a command over the byte limit", { command: "x".repeat(50 * 1024 + 1) }],
		["an empty execution id", { executionId: "" }],
		["a fractional exit code", { exitCode: 1.5 }],
		["no exit code and no reason", { exitCode: null }],
		["a path that is not text", { fullOutputPath: 3 }],
	])("rejects %s", async (_name, fields) => {
		const h = serve();
		const { sessionId } = await h.open();
		expect(await h.shell(sessionId, fields)).toMatchObject({ ok: false, error: { code: "invalid_command" } });
		await h.send(sessionId, "go");
		expect(h.backends[0]?.sent).toEqual(["go"]);
	});

	it("accepts output at exactly the limits", async () => {
		const h = serve();
		const { sessionId } = await h.open();
		// A final newline ends the last line; it does not start another.
		expect(await h.shell(sessionId, { output: "a\n".repeat(2000) })).toMatchObject({ ok: true });
		expect(await h.shell(sessionId, { executionId: "e3", output: `${"a\n".repeat(1999)}a` })).toMatchObject({
			ok: true,
		});
		expect(await h.shell(sessionId, { executionId: "e2", output: "x".repeat(50 * 1024) })).toMatchObject({ ok: true });
	});
});

describe("session.shell_result and resume", () => {
	it("delivers a recorded result after resume, in order, once", async () => {
		const h = serve();
		const { sessionId, savedId } = await h.open();
		await h.shell(sessionId, { executionId: "a", command: "one", output: "1" });
		await h.shell(sessionId, { executionId: "x", command: "hidden", output: "no", excludeFromContext: true });
		await h.shell(sessionId, { executionId: "b", command: "two", output: "2" });
		await h.result({ command: "session.close", sessionId });
		const resumed = await h.result({ command: "session.resume", sessionId: savedId, cwd });
		const id = resumed.sessionId as string;
		expect(await h.shell(id, { executionId: "a", output: "again" })).toMatchObject({ result: { duplicate: true } });
		expect(await h.shell(id, { executionId: "x" })).toMatchObject({ result: { duplicate: true } });
		await h.send(id, "go");
		expect(h.backends[1]?.sent).toEqual([
			`${block("one", "1", "Command exited with code 0.")}\n\n${block("two", "2", "Command exited with code 0.")}\n\ngo`,
		]);
		expect(h.backends[1]?.sent.join()).not.toContain("hidden");
	});

	it("does not deliver again what an earlier prompt carried", async () => {
		const h = serve();
		const { sessionId, savedId } = await h.open();
		await h.shell(sessionId);
		await h.send(sessionId, "go");
		await h.result({ command: "session.close", sessionId });
		const resumed = await h.result({ command: "session.resume", sessionId: savedId, cwd });
		await h.send(resumed.sessionId as string, "next");
		expect(h.backends[1]?.sent).toEqual(["next"]);
		// The delivered text is in the backend's saved history exactly once.
		expect(h.backends[1]?.starts[0]?.resume).toEqual({
			messages: [`${block("echo hi", "hi\n", "Command exited with code 0.")}\n\ngo`],
		});
	});

	it("leaves a result that arrived during a turn out of that turn's saved state", async () => {
		const h = serve();
		const { sessionId, savedId } = await h.open();
		let release = () => {};
		const backend = h.backends[0] as ShellBackend;
		backend.gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await h.result({ command: "session.send", sessionId, prompt: "long" });
		await h.until(() => (backend.sent.length === 1 ? true : undefined));
		await h.shell(sessionId);
		release();
		await h.until(() => (h.finishedTurns(sessionId) === 1 ? true : undefined));
		await h.result({ command: "session.close", sessionId });
		const resumed = await h.result({ command: "session.resume", sessionId: savedId, cwd });
		expect(h.backends[1]?.starts[0]?.resume).toEqual({ messages: ["long"] });
		await h.send(resumed.sessionId as string, "after");
		expect(h.backends[1]?.sent).toEqual([`${block("echo hi", "hi\n", "Command exited with code 0.")}\n\nafter`]);
	});

	it("keeps a result pending after resume when the backend failed before taking the prompt", async () => {
		const h = serve();
		const { sessionId, savedId } = await h.open();
		await h.shell(sessionId);
		(h.backends[0] as ShellBackend).failNext = true;
		await h.send(sessionId, "first");
		await h.result({ command: "session.close", sessionId });
		const resumed = await h.result({ command: "session.resume", sessionId: savedId, cwd });
		await h.send(resumed.sessionId as string, "second");
		expect(h.backends[1]?.sent).toEqual([`${block("echo hi", "hi\n", "Command exited with code 0.")}\n\nsecond`]);
	});

	it("does not deliver again, after resume, a result the backend took before the turn failed", async () => {
		const h = serve();
		const { sessionId, savedId } = await h.open();
		expect(await h.shell(sessionId)).toMatchObject({ ok: true });
		(h.backends[0] as ShellBackend).failAfterAnswer = true;
		await h.send(sessionId, "first");
		expect(h.backends[0]?.sent[0]).toBe(`${block("echo hi", "hi\n", "Command exited with code 0.")}\n\nfirst`);
		await h.send(sessionId, "second");
		expect(h.backends[0]?.sent[1]).toBe("second");
		await h.result({ command: "session.close", sessionId });
		const resumed = await h.result({ command: "session.resume", sessionId: savedId, cwd });
		await h.send(resumed.sessionId as string, "third");
		expect(h.backends[1]?.sent).toEqual(["third"]);
	});

	it.each(["thinking", "tool"] as const)(
		"does not deliver again a result the backend took with only %s before the turn failed",
		async (kind) => {
			const h = serve();
			const { sessionId, savedId } = await h.open();
			expect(await h.shell(sessionId)).toMatchObject({ ok: true });
			const backend = h.backends[0] as ShellBackend;
			backend.failAfter = kind;
			await h.send(sessionId, "first");
			expect(backend.sent[0]).toBe(`${block("echo hi", "hi\n", "Command exited with code 0.")}\n\nfirst`);
			await h.send(sessionId, "second");
			expect(backend.sent[1]).toBe("second");
			await h.result({ command: "session.close", sessionId });
			const resumed = await h.result({ command: "session.resume", sessionId: savedId, cwd });
			await h.send(resumed.sessionId as string, "third");
			expect(h.backends[1]?.sent).toEqual(["third"]);
		},
	);

	it("keeps a result pending when the turn is interrupted before the backend says anything", async () => {
		const h = serve();
		const { sessionId, savedId } = await h.open();
		await h.shell(sessionId);
		const backend = h.backends[0] as ShellBackend;
		let release = () => {};
		let entered = () => {};
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		backend.hold = {
			entered: () => entered(),
			release: () => release(),
			promise: new Promise<void>((resolve) => {
				release = resolve;
			}),
		};
		await h.result({ command: "session.send", sessionId, prompt: "first" });
		await waiting;
		await h.result({ command: "session.interrupt", sessionId });
		await h.until(() => (h.finishedTurns(sessionId) === 1 ? true : undefined));
		await h.send(sessionId, "second");
		const text = `${block("echo hi", "hi\n", "Command exited with code 0.")}\n\nsecond`;
		expect(backend.sent[1]).toBe(text);
		await h.result({ command: "session.close", sessionId });
		const resumed = await h.result({ command: "session.resume", sessionId: savedId, cwd });
		await h.send(resumed.sessionId as string, "third");
		expect(h.backends[1]?.sent).toEqual(["third"]);
	});

	it("delivers more than twenty results, in order, with the next prompt", async () => {
		const h = serve();
		const { sessionId } = await h.open();
		const ids = Array.from({ length: 25 }, (_, index) => `r${index}`);
		for (const id of ids) await h.shell(sessionId, { executionId: id, command: id, output: id });
		await h.send(sessionId, "go");
		const sent = h.backends[0]?.sent[0] ?? "";
		expect(sent).toBe(`${ids.map((id) => block(id, id, "Command exited with code 0.")).join("\n\n")}\n\ngo`);
	});

	it("compacts delivered shell context, not excluded or still-pending results, across resume", async () => {
		const h = serve();
		const { sessionId, savedId } = await h.open();
		await h.send(sessionId, "intro");
		expect(await h.shell(sessionId)).toMatchObject({ ok: true });
		expect(
			await h.shell(sessionId, {
				executionId: "private",
				command: "private-command",
				output: "private-output",
				excludeFromContext: true,
			}),
		).toMatchObject({ ok: true });
		await h.compact(sessionId, "keep the goal");
		expect(h.backends[0]?.compactions).toEqual([{ instructions: "keep the goal", messages: ["intro"] }]);
		await h.result({ command: "session.close", sessionId });
		const resumed = await h.result({ command: "session.resume", sessionId: savedId, cwd });
		const current = resumed.sessionId as string;
		await h.send(current, "go");
		const carried = `${block("echo hi", "hi\n", "Command exited with code 0.")}\n\ngo`;
		expect(h.backends[1]?.sent).toEqual([carried]);
		await h.compact(current, "keep the command output");
		expect(h.backends[1]?.compactions).toEqual([
			{
				instructions: "keep the command output",
				messages: ["intro", carried],
			},
		]);
		await h.send(current, "after");
		expect(h.backends[1]?.sent).toEqual([carried, "after"]);
	});

	it("gives a claude-code session the same prepared prompt", async () => {
		const h = serve();
		const { sessionId } = await h.open("claude-code");
		await h.shell(sessionId);
		await h.send(sessionId, "go");
		expect(h.backends[0]?.sent).toEqual([`${block("echo hi", "hi\n", "Command exited with code 0.")}\n\ngo`]);
	});
});

describe("saved shell entries", () => {
	const header = JSON.stringify({
		kind: "atelier.session",
		version: 1,
		id: "s1",
		cwd: "/x",
		createdAt: "2026-01-01T00:00:00.000Z",
	});
	const result = {
		executionId: "e",
		command: "ls",
		excludeFromContext: false,
		output: "",
		exitCode: 0,
		cancelled: false,
		truncated: false,
	};
	const parse = (...entries: unknown[]) =>
		parseSessionFile(`${[header, ...entries.map((e) => JSON.stringify(e))].join("\n")}\n`, "s1");

	it("reads a valid entry and a file saved before they existed", () => {
		expect(parse({ type: "shell_result", result }, { type: "prompt", turnId: "t", text: "x" })).toMatchObject({
			ok: true,
		});
	});

	it.each([
		[{ type: "shell_result", result: { ...result, exitCode: "0" } }],
		[{ type: "shell_result" }],
		[{ type: "prompt", turnId: "t", text: "x", shellResults: [1] }],
	])("calls %j corrupt", (entry) => {
		expect(parse(entry)).toMatchObject({ ok: false, code: "corrupt" });
	});
});
