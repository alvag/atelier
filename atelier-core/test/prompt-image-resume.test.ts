import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ImageAttachment } from "../src/images.ts";
import {
	type AgentBackend,
	type AtelierEvent,
	type AtelierEventBody,
	type BackendName,
	type BackendSession,
	type BackendStartOptions,
	decodeServerMessage,
	RpcServer,
	type ServerMessage,
} from "../src/index.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };

const PNG = (
	await sharp({ create: { width: 1, height: 1, channels: 4, background: "red" } })
		.png()
		.toBuffer()
).toString("base64");

/** A native-shaped backend: keeps the images it was sent as Messages image blocks in an opaque resume state. */
class ImageBackend implements AgentBackend {
	readonly sent: { prompt: string; images: readonly ImageAttachment[] | undefined }[] = [];
	readonly starts: BackendStartOptions[] = [];
	summaries = 0;
	compaction: (AtelierEventBody & { parentCallId?: string })[] = [];
	readonly id: string;
	readonly keepsState: boolean | "empty";
	constructor(id: string, keepsState: boolean | "empty" = true) {
		this.id = id;
		this.keepsState = keepsState;
	}

	async start(options: BackendStartOptions): Promise<BackendSession> {
		this.starts.push(options);
		const messages = options.resume && "messages" in options.resume ? [...options.resume.messages] : [];
		const backend = this;
		return {
			currentModel: () => "claude-haiku-5-5",
			async *send(prompt, images) {
				backend.sent.push({ prompt, images });
				const blocks = (images ?? []).map((image) => ({
					type: "image",
					source: { type: "base64", media_type: image.mimeType, data: image.data },
				}));
				messages.push({ role: "user", content: [...blocks, { type: "text", text: prompt }] });
				yield finished;
			},
			compact: async function* () {
				yield* backend.compaction;
			},
			summarize: async () => {
				backend.summaries++;
				return { text: "## Goal\n- carried", usage };
			},
			resumeState: () =>
				backend.keepsState ? { messages: backend.keepsState === "empty" ? [] : messages } : undefined,
			interrupt: async () => {},
			close: async () => {},
		};
	}
}

let root: string;
let home: string;
let cwd: string;
let stop: (() => Promise<void>) | undefined;
beforeEach(async () => {
	await mkdir("odd", { recursive: true });
	root = await realpath(await mkdtemp(join("odd", "prompt-image-resume-")));
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

/** An RPC server whose backend factory records every backend it makes, named like the backend asked for. */
function serve(keepsState: boolean | "empty" = true) {
	const input = new PassThrough();
	const messages: ServerMessage[] = [];
	const backends: ImageBackend[] = [];
	const waiting: (() => void)[] = [];
	const server = new RpcServer({
		input,
		write: (line) => {
			messages.push(decodeServerMessage(line.trimEnd()) as ServerMessage);
			for (const wake of waiting.splice(0)) wake();
		},
		createBackend: (name: BackendName) => {
			const backend = new ImageBackend(name, keepsState);
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
	const result = async (command: Record<string, unknown>) => {
		const id = `c${++next}`;
		input.write(`${JSON.stringify({ type: "command", id, ...command })}\n`);
		const response = await until(() => messages.find((m) => m.type === "response" && m.id === id));
		if (response.type !== "response" || !response.ok) throw new Error(`${command.command} failed`);
		return response.result;
	};
	const eventsOf = (sessionId: string): AtelierEvent[] =>
		messages.flatMap((m) => (m.type === "event" && m.sessionId === sessionId ? [m.event] : []));
	/** Runs a command that starts a turn and answers the events that turn produced. */
	const turn = async (sessionId: string, command: Record<string, unknown>) => {
		const before = eventsOf(sessionId).length;
		await result({ sessionId, ...command });
		return until(() => {
			const events = eventsOf(sessionId).slice(before);
			return events.some((e) => e.type === "turn_finished") ? events : undefined;
		});
	};
	const send = (sessionId: string, prompt: string, images?: ImageAttachment[]) =>
		turn(sessionId, { command: "session.send", prompt, ...(images ? { images } : {}) });
	const open = async () => {
		const started = await result({
			command: "session.start",
			cwd,
			backend: "anthropic-api",
			model: "claude-haiku-5-5",
		});
		return { sessionId: started.sessionId as string, savedId: started.savedId as string };
	};
	stop = () => {
		input.end();
		return done;
	};
	return { result, open, send, turn, backends };
}

const warning = (events: AtelierEvent[], code: string) =>
	events.find((e): e is Extract<AtelierEvent, { type: "error" }> => e.type === "error" && e.code === code);
const expectWarning = (events: AtelierEvent[], code: string) =>
	expect(warning(events, code)).toMatchObject({ recoverable: true, message: expect.stringMatching(/image/i) });

/** Saves a session whose first prompt has one image, closes it and resumes it. */
async function resumedWithImage(h: ReturnType<typeof serve>, prompt: string) {
	const started = await h.open();
	await h.send(started.sessionId, prompt, [{ mimeType: "image/png", data: PNG }]);
	await h.result({ command: "session.close", sessionId: started.sessionId });
	const resumed = await h.result({ command: "session.resume", sessionId: started.savedId, cwd });
	return {
		resumed: { sessionId: resumed.sessionId as string, entries: resumed.entries },
		sent: h.backends[0]?.sent[0]?.images?.[0],
	};
}

describe("prompt images across session.resume", () => {
	it.each([
		["", "image only"],
		["look at this", "text and image"],
	])("keeps the normalized pixels in the resume state for %j (%s), not in the entries", async (prompt) => {
		const h = serve();
		const { resumed, sent } = await resumedWithImage(h, prompt);
		expect(sent?.data).toEqual(expect.any(String));
		expect(h.backends[1]?.starts[0]?.resume).toEqual({
			messages: [
				{
					role: "user",
					content: [
						{ type: "image", source: { type: "base64", media_type: sent?.mimeType, data: sent?.data } },
						{ type: "text", text: prompt },
					],
				},
			],
		});
		expect(resumed.entries).toContainEqual(expect.objectContaining({ type: "prompt", text: prompt, imageCount: 1 }));
		expect(JSON.stringify(resumed.entries)).not.toContain(sent?.data);

		const events = await h.send(resumed.sessionId, "text only");
		expect(h.backends[1]?.sent).toEqual([{ prompt: "text only", images: undefined }]);
		expect(warning(events, "image_history_summarized")).toBeUndefined();
	});

	it("warns only after a successful main-agent compaction that earlier images were summarized", async () => {
		const h = serve();
		const { resumed } = await resumedWithImage(h, "see");
		const backend = h.backends[1] as ImageBackend;
		const base = { reason: "manual", tokensBefore: 9, kept: 1, usage } as const;
		backend.compaction = [{ type: "compaction_finished", ok: false, error: "no", ...base }, finished];
		const failed = await h.turn(resumed.sessionId, { command: "session.compact" });
		expect(warning(failed, "image_history_summarized")).toBeUndefined();

		backend.compaction = [{ type: "compaction_finished", ok: true, parentCallId: "child", ...base }, finished];
		const child = await h.turn(resumed.sessionId, { command: "session.compact" });
		expect(warning(child, "image_history_summarized")).toBeUndefined();

		backend.compaction = [{ type: "compaction_finished", ok: true, tokensAfter: 1, ...base }, finished];
		expectWarning(await h.turn(resumed.sessionId, { command: "session.compact" }), "image_history_summarized");
	});

	it("summarizes through the old backend when the backend changes right after resume, then warns on the next turn", async () => {
		const h = serve();
		const { resumed } = await resumedWithImage(h, "see");
		await h.result({ command: "session.set_backend", sessionId: resumed.sessionId, backend: "opencode-go" });
		expect(h.backends[1]?.summaries).toBe(1);
		expectWarning(await h.send(resumed.sessionId, "continue"), "image_history_summarized");
	});

	it.each([false, "empty"] as const)("says the images were not kept with resume state %s", async (keepsState) => {
		const h = serve(keepsState);
		const { resumed } = await resumedWithImage(h, "see");
		expect(h.backends[1]?.starts[0]?.resume).toEqual(keepsState === "empty" ? { messages: [] } : undefined);
		expectWarning(await h.send(resumed.sessionId, "continue"), "image_history_unavailable");
	});
});
