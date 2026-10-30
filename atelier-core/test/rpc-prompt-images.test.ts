import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageAttachment } from "../src/images.ts";
import {
	type AgentBackend,
	type AtelierEventBody,
	type BackendSession,
	decodeServerMessage,
	RpcServer,
	type RpcServerOptions,
	type ServerMessage,
} from "../src/index.ts";
import { ModelData, useModelData } from "../src/model-catalog/index.ts";
import { normalizePromptImages } from "../src/prompt-images.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };
const pixel = sharp({ create: { width: 3, height: 2, channels: 3, background: "#2468ac" } }).png();
const image: ImageAttachment = { mimeType: "image/png", data: (await pixel.toBuffer()).toString("base64") };
const invalid = (code: string) => ({ ok: false, error: { code } });

let dir: string;
const cleanups: (() => unknown)[] = [];
const defer = () => {
	const d = Promise.withResolvers<void>();
	cleanups.unshift(d.resolve);
	return d;
};
beforeEach(async () => {
	await mkdir(resolve("node_modules/.cache"), { recursive: true });
	dir = await mkdtemp(resolve("node_modules/.cache/rpc-images-"));
});
afterEach(async () => {
	useModelData(new ModelData());
	await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
	await rm(dir, { recursive: true, force: true });
});

class ImageBackend implements AgentBackend {
	readonly id = "anthropic-api";
	model = "claude-haiku-5-5";
	readonly sends: { prompt: string; images: readonly ImageAttachment[] | undefined }[] = [];
	readonly configured: unknown[] = [];
	hold: PromiseWithResolvers<void> | undefined;
	configuring: PromiseWithResolvers<void> | undefined;
	async start(): Promise<BackendSession> {
		const self = this;
		return {
			currentModel: () => self.model,
			async *send(prompt, images) {
				self.sends.push({ prompt, images });
				await self.hold?.promise;
				yield finished;
			},
			configure: async (change) => {
				self.configured.push(change);
				await self.configuring?.promise;
			},
			interrupt: async () => self.hold?.resolve(),
			close: async () => {},
		};
	}
}

/** `gate` holds the real normalizer until released; it rejects when the signal aborts, as the native one does. */
function serve(gate?: PromiseWithResolvers<void>) {
	const input = new PassThrough();
	const messages: ServerMessage[] = [];
	const backend = new ImageBackend();
	let prepared = 0;
	const options: RpcServerOptions & { normalizeImages?: typeof normalizePromptImages } = {
		input,
		write: (line) => messages.push(decodeServerMessage(line.trimEnd()) as ServerMessage),
		createBackend: () => backend,
		tools: [],
		systemPromptAppend: "",
		home: dir,
		normalizeImages: async (images, opts) => {
			prepared++;
			await gate?.promise;
			opts?.signal?.throwIfAborted();
			return normalizePromptImages(images, opts);
		},
	};
	const done = new RpcServer(options).run();
	cleanups.push(async () => {
		input.end();
		await done;
	});
	let next = 0;
	const send = (command: Record<string, unknown>) => {
		const id = `c${++next}`;
		input.write(`${JSON.stringify({ type: "command", id, ...command })}\n`);
		return id;
	};
	const until = (condition: () => boolean) =>
		vi.waitFor(() => expect(condition()).toBe(true), { timeout: 2000, interval: 5 });
	const reply = async (id: string) => {
		const found = () => messages.find((m) => m.type === "response" && m.id === id);
		await until(() => found() !== undefined);
		return found() as Extract<ServerMessage, { type: "response" }>;
	};
	const ask = (command: Record<string, unknown>) => reply(send(command));
	const turn = (sessionId: string, body: Record<string, unknown>) =>
		ask({ command: "session.send", sessionId, ...body });
	const open = async () => {
		const started = await ask({ command: "session.start", cwd: dir, backend: "anthropic-api" });
		return (started as unknown as { result: { sessionId: string } }).result.sessionId;
	};
	const finishedTurns = (id: string) =>
		messages.filter((m) => m.type === "event" && m.sessionId === id && m.event.type === "turn_finished");
	return { ask, turn, send, reply, open, until, finishedTurns, backend, messages, input, prepared: () => prepared };
}

describe("session.send with images", () => {
	it("sends an image-only prompt and keeps text-only callers as they were", async () => {
		const h = serve();
		const sessionId = await h.open();
		const images = [image];
		for (const [i, body] of [{ prompt: "", images }, { prompt: "hi" }].entries()) {
			expect((await h.turn(sessionId, body)).ok).toBe(true);
			await h.until(() => h.finishedTurns(sessionId).length === i + 1);
		}
		const [first, second] = h.backend.sends;
		expect(first).toEqual({ prompt: "", images: await normalizePromptImages(images) });
		expect({ ...second, images: second?.images ?? [] }).toEqual({ prompt: "hi", images: [] });
	});

	it("refuses bad attachments as invalid_command or invalid_image, with no ACK, event or backend call", async () => {
		const h = serve();
		const sessionId = await h.open();
		const before = h.messages.length;
		const bmp = [{ mimeType: "image/bmp", data: image.data }];
		for (const images of [bmp, Array(21).fill(image)])
			expect(await h.turn(sessionId, { prompt: "x", images })).toMatchObject(invalid("invalid_command"));
		for (const shape of [{ images: [] }, {}])
			expect(await h.turn(sessionId, { prompt: "", ...shape })).toMatchObject(invalid("invalid_command"));
		for (const data of [`${image.data}\n`, Buffer.from("not an image at all").toString("base64")]) {
			const images = [{ ...image, data }];
			expect(await h.turn(sessionId, { prompt: "x", images })).toMatchObject(invalid("invalid_image"));
		}
		expect(h.messages.slice(before).every((m) => m.type === "response" && !m.ok)).toBe(true);
		expect(h.backend.sends).toEqual([]);
	});

	it("refuses an unknown or unsupported current model before normalizing", async () => {
		const h = serve();
		const sessionId = await h.open();
		const images = [image];
		for (const model of ["no-such-model", "claude-unknown-9"]) {
			h.backend.model = model;
			expect(await h.turn(sessionId, { prompt: "x", images })).toMatchObject(invalid("image_input_unsupported"));
		}
		h.backend.model = "claude-haiku-5-5";
		useModelData(new ModelData({ "anthropic-api": [{ id: h.backend.model, images: false }] }));
		expect(await h.turn(sessionId, { prompt: "x", images })).toMatchObject(invalid("image_input_unsupported"));
		expect([h.prepared(), h.backend.sends]).toEqual([0, []]);
	});

	it("refuses images while a backend turn runs", async () => {
		const h = serve();
		const sessionId = await h.open();
		h.backend.hold = defer();
		await h.turn(sessionId, { prompt: "long" });
		await h.until(() => h.backend.sends.length === 1);
		const busy = await h.turn(sessionId, { prompt: "", images: [image] });
		expect(busy).toMatchObject({
			ok: false,
			error: { code: "busy", message: "Images cannot be queued. Wait for the current turn to finish." },
		});
	});

	it("reserves the session while images are prepared, then sends exactly once", async () => {
		const gate = defer();
		const h = serve(gate);
		const sessionId = await h.open();
		const images = [image];
		const original = h.send({ command: "session.send", sessionId, prompt: "see", images });
		await h.until(() => h.prepared() === 1);
		const others: Record<string, unknown>[] = [
			{ command: "session.send", prompt: "again" },
			{ command: "session.send", prompt: "", images },
			{ command: "session.queue", kind: "follow_up", text: "later" },
			{ command: "session.review" },
			{ command: "session.compact" },
			{ command: "session.undo_correction", reviewId: "r1" },
			{ command: "session.set_model", model: "claude-opus-5-5" },
			{ command: "session.set_effort", effort: "low" },
			{ command: "session.set_profile", profile: "default" },
			{ command: "session.set_backend", backend: "anthropic-api" },
			{ command: "session.set_mode", mode: "auto" },
		];
		for (const other of others) {
			const command = { sessionId, ...other };
			expect(await h.ask(command), JSON.stringify(command)).toMatchObject(invalid("busy"));
		}
		expect(h.messages.filter((m) => m.type === "response" && m.id === original)).toEqual([]);
		expect([h.backend.sends, h.backend.configured]).toEqual([[], []]);
		gate.resolve();
		expect((await h.reply(original)).ok).toBe(true);
		await h.until(() => h.finishedTurns(sessionId).length >= 1);
		expect(h.backend.sends).toHaveLength(1);
		expect(h.backend.sends[0]).toEqual({ prompt: "see", images: await normalizePromptImages(images) });
	});

	it("refuses images while a configuration already in flight awaits the backend", async () => {
		const h = serve();
		const sessionId = await h.open();
		h.backend.configuring = defer();
		const change = h.send({ command: "session.set_model", sessionId, model: "claude-haiku-5-5" });
		await h.until(() => h.backend.configured.length === 1);
		expect(await h.turn(sessionId, { prompt: "x", images: [image] })).toMatchObject(invalid("busy"));
		expect(h.prepared()).toBe(0);
		h.backend.configuring.resolve();
		expect((await h.reply(change)).ok).toBe(true);
	});

	it("rechecks catalog support after preparing images", async () => {
		const gate = defer();
		const h = serve(gate);
		const sessionId = await h.open();
		const original = h.send({ command: "session.send", sessionId, prompt: "x", images: [image] });
		await h.until(() => h.prepared() === 1);
		useModelData(new ModelData({ "anthropic-api": [{ id: h.backend.model, images: false }] }));
		gate.resolve();
		expect(await h.reply(original)).toMatchObject(invalid("image_input_unsupported"));
		expect(h.backend.sends).toEqual([]);
	});

	it.each(["shutdown", "disconnect"])("%s during preparation never sends the late result", async (command) => {
		const gate = defer();
		const h = serve(gate);
		const sessionId = await h.open();
		const original = h.send({ command: "session.send", sessionId, prompt: "x", images: [image] });
		await h.until(() => h.prepared() === 1);
		if (command === "shutdown") expect((await h.ask({ command })).ok).toBe(true);
		else {
			const ended = new Promise<void>((resolve) => h.input.once("end", () => setImmediate(resolve)));
			h.input.end();
			await ended;
		}
		gate.resolve();
		expect(await h.reply(original)).toMatchObject(invalid("session_closed"));
		expect(h.backend.sends).toEqual([]);
	});

	it.each(["session.interrupt", "session.close"])("%s during preparation rejects the send", async (command) => {
		const gate = defer();
		const h = serve(gate);
		const sessionId = await h.open();
		const original = h.send({ command: "session.send", sessionId, prompt: "x", images: [image] });
		await h.until(() => h.prepared() === 1);
		const stop = h.send({ command, sessionId });
		gate.resolve();
		await h.reply(stop);
		expect((await h.reply(original)).ok).toBe(false);
		expect(h.backend.sends).toEqual([]);
	});
});
