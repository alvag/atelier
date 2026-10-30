import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { AuthStore, authFile } from "../src/auth-store.ts";
import type { BackendSession, BackendStartOptions, ToolCall } from "../src/backend.ts";
import { createBackend } from "../src/backend-factory.ts";
import { CodexAccess, type CodexVariant } from "../src/backends/openai-codex/access.ts";
import { OpenAiCodexBackend } from "../src/backends/openai-codex/backend.ts";
import { SUMMARY_HEADINGS } from "../src/compaction/compactor.ts";
import type { AtelierEventBody } from "../src/events.ts";
import { ModelData, useModelData } from "../src/model-catalog/index.ts";
import { defineTool } from "../src/tools/types.ts";
import { FakeOpenAiAuth, fakeCodexAccess, fakeJwt, fakeRefresh } from "./support/fake-openai-auth.ts";
import { callItem, completed, FakeResponses, textItem } from "./support/fake-responses.ts";
import { requireIsolatedHome } from "./support/login-isolation.ts";

requireIsolatedHome();

let home: string;
let store: AuthStore;
let api: FakeResponses;
let auth: FakeOpenAiAuth;
let accountId: string;
let legacy: { access: string; refresh: string };
let chatgpt: { access: string; refresh: string };

const echoTool = defineTool({
	name: "echo",
	description: "Echoes the text back.",
	inputShape: { text: z.string() },
	execute: async ({ text }) => ({ ok: true, output: `echo: ${text}`, summary: text, truncated: false }),
});

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "atelier-codex-backend-"));
	store = new AuthStore(authFile(home));
	api = await new FakeResponses().start();
	auth = await new FakeOpenAiAuth().start();
	accountId = `acct-${randomUUID()}`;
	legacy = { access: fakeCodexAccess(accountId), refresh: fakeRefresh() };
	chatgpt = { access: fakeJwt({ sub: randomUUID() }), refresh: fakeRefresh() };
});

afterEach(async () => {
	await api.stop();
	await auth.stop();
	await rm(home, { recursive: true, force: true });
});

const signInLegacy = (expires = Date.now() + 3_600_000) =>
	store.set("openai-codex", { type: "oauth", ...legacy, expires, accountId } as never);
const signInChatGpt = () =>
	store.set("openai-chatgpt", {
		type: "oauth",
		...chatgpt,
		expires: Date.now() + 3_600_000,
		clientId: "issued-1",
		scopes: [],
	} as never);

async function start(options: Partial<BackendStartOptions> = {}, variant?: CodexVariant) {
	const calls: ToolCall[] = [];
	const backend = new OpenAiCodexBackend({
		store,
		codexUrl: api.url,
		openaiUrl: `${api.url}/v1`,
		authUrl: auth.url,
		baseDelayMs: 0,
		...(variant ? { variant } : {}),
	});
	const session = await backend.start({
		cwd: "/work",
		systemPromptAppend: "Follow ODD.",
		tools: [echoTool],
		executeTool: async (call) => {
			calls.push(call);
			return { ok: true, output: `echo: ${(call.input as { text: string }).text}` };
		},
		...options,
	});
	return { session, calls };
}

it.each(["legacy", "chatgpt"] as const)(
	"sends prompt images as input_image items, also without text, and keeps them through resume on %s",
	async (variant) => {
		await (variant === "legacy" ? signInLegacy() : signInChatGpt());
		const data = (
			await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } })
				.png()
				.toBuffer()
		).toString("base64");
		const images = [{ mimeType: "image/png" as const, data }];
		const part = { type: "input_image", image_url: `data:image/png;base64,${data}`, detail: "auto" };
		api.answers.push(...Array.from({ length: 3 }, () => ({ events: completed([textItem("Done.")]) })));
		const { session } = await start({}, variant);
		for await (const _ of session.send("What is this?", images));
		for await (const _ of session.send("", images));
		const userItem = (index: number) =>
			(api.requests[index]?.body.input as Record<string, unknown>[] | undefined)?.at(-1);
		expect(userItem(0)).toEqual({
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "What is this?" }, part],
		});
		expect(userItem(1)).toEqual({ type: "message", role: "user", content: [part] });
		const resume = session.resumeState?.();
		if (resume === undefined) throw new Error("Missing image history.");
		await session.close();
		const { session: resumed } = await start({ resume }, variant);
		for await (const _ of resumed.send("And now?"));
		const input = api.requests[2]?.body.input as Record<string, unknown>[];
		expect(input).toContainEqual({
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "What is this?" }, part],
		});
		expect(input).toContainEqual({ type: "message", role: "user", content: [part] });
		await resumed.close();
	},
);

it("refuses fresh images for a model that does not take them before touching the history", async () => {
	await signInLegacy();
	useModelData(new ModelData({ "openai-codex": [{ id: "text-only", images: false }] }));
	const { session } = await start({ model: "text-only" });
	await expect(
		(async () => {
			for await (const _ of session.send("Look", [{ mimeType: "image/png", data: "AA==" }]));
		})(),
	).rejects.toThrow("Image input is not supported by openai-codex/text-only.");
	expect(api.requests).toHaveLength(0);
	expect(session.resumeState?.()).toBeUndefined();
	await session.close();
});

it.each(["legacy", "chatgpt"] as const)(
	"carries tool images, resume and explicit model omissions on %s",
	async (variant) => {
		await (variant === "legacy" ? signInLegacy() : signInChatGpt());
		useModelData(new ModelData({ "openai-codex": [{ id: "text-only", images: false }] }));
		const data = (
			await sharp({ create: { width: 1, height: 1, channels: 4, background: "transparent" } })
				.png()
				.toBuffer()
		).toString("base64");
		api.answers.push(
			{ events: completed([callItem("a", "echo", { text: "one" }), callItem("b", "echo", { text: "two" })]) },
			...Array.from({ length: 5 }, () => ({ events: completed([textItem("Done.")]) })),
		);
		const { session } = await start(
			{
				executeTool: async () => ({
					ok: true,
					output: "Image: 1×1 (image/png)",
					images: [{ mimeType: "image/png", data }],
				}),
			},
			variant,
		);
		try {
			await turn(session);
			const input = api.requests[1]?.body.input as Record<string, unknown>[];
			const companion = {
				type: "message",
				role: "user",
				content: [
					{ type: "input_text", text: "Images from tool result a:" },
					{ type: "input_image", image_url: `data:image/png;base64,${data}`, detail: "auto" },
					{ type: "input_text", text: "Images from tool result b:" },
					{ type: "input_image", image_url: `data:image/png;base64,${data}`, detail: "auto" },
				],
			};
			expect(input.slice(-3)).toEqual([
				{ type: "function_call_output", call_id: "a", output: "Image: 1×1 (image/png)" },
				{ type: "function_call_output", call_id: "b", output: "Image: 1×1 (image/png)" },
				companion,
			]);
			const resume = session.resumeState?.();
			if (resume === undefined) throw new Error("Missing image history.");
			await session.close();
			const { session: resumed } = await start({ resume }, variant);
			try {
				await turn(resumed, "Use the pixels again.");
				expect(api.requests[2]?.body.input).toContainEqual(companion);
				await resumed.configure?.({ model: "text-only" });
				await turn(resumed, "What remains?");
				const omitted = JSON.stringify(api.requests[3]?.body.input);
				expect(omitted.split("[image omitted: text-only does not accept images]")).toHaveLength(3);
				expect(omitted).not.toContain(data);
				api.answers[0] = { events: completed([textItem(SUMMARY_HEADINGS.join("\n"))]) };
				await resumed.summarize?.();
				expect(
					JSON.stringify(api.requests[4]?.body.input).split("[image omitted: text-only does not accept images]"),
				).toHaveLength(3);
				await resumed.configure?.({ model: "gpt-6-sol" });
				await turn(resumed, "Use the original pixels.");
				expect(api.requests[5]?.body.input).toContainEqual(companion);
			} finally {
				await resumed.close();
			}
		} finally {
			await session.close();
			useModelData(new ModelData());
		}
	},
);

it("gives the Codex catalog the Codex sign-in's token and id, and never another variant's token", async () => {
	const access = () => new CodexAccess({ store, authUrl: auth.url });
	expect(await access().catalogHeaders()).toBeUndefined();
	await signInChatGpt();
	// Sign in with ChatGPT's token goes to api.openai.com only: the Codex host never gets it.
	expect(await access().catalogHeaders()).toBeUndefined();
	await signInLegacy();
	expect(await access().catalogHeaders()).toEqual({
		authorization: `Bearer ${legacy.access}`,
		"chatgpt-account-id": accountId,
	});
	expect(await new CodexAccess({ store, authUrl: auth.url, variant: "chatgpt" }).catalogHeaders()).toBeUndefined();
});

it("takes the window of the model it runs, also after the model changes", async () => {
	await signInLegacy();
	useModelData(new ModelData({ "openai-codex": [{ id: "gpt-6.1-terra", contextWindow: 400_000 }] }));
	try {
		const { session } = await start();
		api.answers.push({ events: completed([textItem("one")]) });
		expect((await turn(session)).at(-1)).toMatchObject({ context: { window: 272_000 } });
		await session.configure?.({ model: "gpt-6.1-terra" });
		api.answers.push({ events: completed([textItem("two")]) });
		expect((await turn(session, "next")).at(-1)).toMatchObject({
			context: { window: 400_000, compactAt: 400_000 - 32_000 - 16_384 },
		});
	} finally {
		useModelData(new ModelData());
	}
});

async function turn(session: BackendSession, prompt = "hi"): Promise<AtelierEventBody[]> {
	const events: AtelierEventBody[] = [];
	for await (const event of session.send(prompt)) events.push(event);
	return events;
}

it("runs a turn without a request limit when nobody passes one, until the model stops", async () => {
	await signInLegacy();
	for (let i = 0; i < 51; i++)
		api.answers.push({ events: completed([callItem(`call_${i}`, "echo", { text: `${i}` })]) });
	api.answers.push({ events: completed([textItem("Done")]) });
	const { session, calls } = await start();
	const events = await turn(session);
	expect(api.requests).toHaveLength(52);
	expect(calls).toHaveLength(51);
	expect(events.filter((event) => event.type === "error")).toEqual([]);
	expect(events.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "end_turn", requests: 52 });
});

it("stops at the request limit the caller passes with a turn_limit error", async () => {
	await signInLegacy();
	for (let i = 0; i < 3; i++)
		api.answers.push({ events: completed([callItem(`call_${i}`, "echo", { text: `${i}` })]) });
	const { session } = await start({ maxRequestsPerTurn: 2 });
	const events = await turn(session);
	expect(api.requests).toHaveLength(2);
	expect(events.filter((event) => event.type === "error")).toEqual([
		{
			type: "error",
			code: "turn_limit",
			message: "The turn reached its limit of 2 model requests.",
			recoverable: true,
		},
	]);
	expect(events.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "turn_limit", requests: 2 });
});

it("runs a turn on ChatGPT's Codex endpoint: the account, the tools, the reasoning, the usage with the cache", async () => {
	await signInLegacy();
	api.answers.push({
		events: [
			{ type: "response.reasoning_summary_text.delta", delta: "Plan" },
			...completed(
				[
					{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque" },
					callItem("call_1", "echo", { text: "x" }),
				],
				{ input_tokens: 100, input_tokens_details: { cached_tokens: 60 }, output_tokens: 10 },
			),
		],
	});
	api.answers.push({
		events: [
			{ type: "response.output_text.delta", delta: "Done" },
			...completed([{ ...textItem("Done"), id: "msg_1", status: "completed" }], {
				input_tokens: 130,
				output_tokens: 4,
			}),
		],
	});
	const { session, calls } = await start({ thinking: "high" });
	const events = await turn(session);

	expect(events[0]).toMatchObject({
		type: "session_started",
		backend: "openai-codex",
		model: "gpt-6-sol",
		authSource: "subscription",
		effort: "high",
	});
	expect(events.filter((event) => event.type === "thinking_delta" || event.type === "text_delta")).toEqual([
		{ type: "thinking_delta", text: "Plan" },
		{ type: "text_delta", text: "Done" },
	]);
	expect(calls).toEqual([{ tool: "echo", input: { text: "x" }, callId: "call_1" }]);
	expect(events.at(-1)).toMatchObject({
		type: "turn_finished",
		stopReason: "end_turn",
		requests: 2,
		usage: { input: 170, cacheRead: 60, output: 14, cacheWrite: 0 },
		context: { window: 272_000 },
	});
	expect(events.at(-1)).not.toHaveProperty("costUsd");

	const [first, second] = api.requests;
	expect(first?.path).toBe("/codex/responses");
	expect(first?.headers).toMatchObject({
		authorization: `Bearer ${legacy.access}`,
		"chatgpt-account-id": accountId,
		"openai-beta": "responses=experimental",
		originator: "atelier",
	});
	expect(first?.body).toMatchObject({
		model: "gpt-6-sol",
		store: false,
		stream: true,
		reasoning: { effort: "high", summary: "auto" },
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: first?.headers["session-id"],
		tools: [{ type: "function", name: "echo", strict: false }],
	});
	expect(first?.body.instructions).toContain("Working directory: /work");
	expect(first?.body.instructions).toContain("Follow ODD.");
	expect(second?.body.input).toEqual([
		{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
		{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque" },
		{ type: "function_call", call_id: "call_1", name: "echo", arguments: '{"text":"x"}' },
		{ type: "function_call_output", call_id: "call_1", output: "echo: x" },
	]);

	// The answer enters the history without the ids a request without storage cannot refer to.
	api.answers.push({ events: completed([textItem("again")]) });
	await turn(session, "more");
	expect(((api.requests[2]?.body.input ?? []) as unknown[]).slice(4)).toEqual([
		{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] },
		{ type: "message", role: "user", content: [{ type: "input_text", text: "more" }] },
	]);
});

it("changes the model and the reasoning between turns, and resumes a saved conversation", async () => {
	await signInLegacy();
	api.answers.push({ events: completed([textItem("one")]) });
	const { session } = await start();
	await turn(session);
	expect(api.requests[0]?.body.reasoning).toEqual({ summary: "auto" });
	await session.configure?.({ model: "gpt-6-luna", thinking: "off" });
	api.answers.push({ events: completed([textItem("two")]) });
	const events = await turn(session, "next");
	expect(api.requests[1]?.body).toMatchObject({ model: "gpt-6-luna", reasoning: { effort: "none" } });
	expect(events.at(-1)).toMatchObject({ type: "turn_finished" });

	const saved = session.resumeState?.();
	const { session: resumed } = await start(saved === undefined ? {} : { resume: saved });
	api.answers.push({ events: completed([textItem("three")]) });
	await turn(resumed, "last");
	expect(api.requests[2]?.body.input).toHaveLength(5);
});

it("refreshes a token about to expire before the request, and keeps the new one", async () => {
	await signInLegacy(Date.now() + 60_000);
	const fresh = { access: fakeCodexAccess(accountId), refresh: fakeRefresh() };
	auth.routes.set("/oauth/token", () => ({
		json: { access_token: fresh.access, refresh_token: fresh.refresh, expires_in: 3600 },
	}));
	api.answers.push({ events: completed([textItem("ok")]) });
	const { session } = await start();
	await turn(session);
	expect(auth.requests[0]?.body).toMatchObject({ grant_type: "refresh_token", refresh_token: legacy.refresh });
	expect(api.requests[0]?.headers.authorization).toBe(`Bearer ${fresh.access}`);
	expect(store.get("openai-codex")).toMatchObject({ access: fresh.access, refresh: fresh.refresh, accountId });
});

it("refreshes a refused token once and retries, and asks to sign in again when the refresh is refused too", async () => {
	await signInLegacy();
	const fresh = fakeCodexAccess(accountId);
	auth.routes.set("/oauth/token", () => ({
		json: { access_token: fresh, refresh_token: fakeRefresh(), expires_in: 3600 },
	}));
	api.answers.push({ status: 401, json: { error: { message: "token expired" } } });
	api.answers.push({ events: completed([textItem("ok")]) });
	const { session } = await start();
	expect((await turn(session)).at(-1)).toMatchObject({ type: "turn_finished", stopReason: "end_turn" });
	expect(api.requests[1]?.headers.authorization).toBe(`Bearer ${fresh}`);

	auth.routes.set("/oauth/token", () => ({ status: 400, json: { error: "invalid_grant" } }));
	api.answers.push({ status: 401, json: { error: { message: "token expired" } } });
	const events = await turn(session, "again");
	const error = events.find((event) => event.type === "error");
	expect(error).toMatchObject({ code: "not_logged_in", recoverable: false });
	expect((error as { message: string }).message).toContain("/login account openai-codex");
});

it("asks to sign in again, at once, when the token expired and OpenAI refuses its refresh", async () => {
	await signInLegacy(Date.now() - 1);
	auth.routes.set("/oauth/token", () => ({ status: 400, json: { error: "invalid_grant" } }));
	const { session } = await start();
	const events = await turn(session);
	const error = events.find((event) => event.type === "error");
	expect(error).toMatchObject({ code: "not_logged_in", recoverable: false });
	expect((error as { message: string }).message).toContain("/login account openai-codex");
	expect((error as { message: string }).message).not.toContain("Could not reach");
	expect(events.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "error", requests: 0 });
	expect(auth.requests.filter((request) => request.path === "/oauth/token")).toHaveLength(1);
	expect(api.requests).toHaveLength(0);
});

it("says how to sign in when there is no sign-in", async () => {
	const { session } = await start();
	const events = await turn(session);
	expect(events.find((event) => event.type === "error")).toMatchObject({ code: "not_logged_in" });
	expect(events.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "error", requests: 0 });
	expect(api.requests).toHaveLength(0);
});

it("moves to Sign in with ChatGPT when the Codex endpoint refuses Atelier, unless a variant was forced", async () => {
	await signInLegacy();
	await signInChatGpt();
	api.answers.push({ status: 403, json: { error: { message: "client not allowed" } } });
	api.answers.push({ events: completed([textItem("ok")]) });
	const { session } = await start();
	const events = await turn(session);
	expect(events.find((event) => event.type === "error")).toMatchObject({ code: "variant_changed", recoverable: true });
	expect(api.requests.map((request) => request.path)).toEqual(["/codex/responses", "/v1/responses"]);
	expect(api.requests[1]?.headers.authorization).toBe(`Bearer ${chatgpt.access}`);
	expect(api.requests[1]?.headers).not.toHaveProperty("chatgpt-account-id");
	api.answers.push({ events: completed([textItem("ok")]) });
	await turn(session, "again");
	expect(api.requests[2]?.path).toBe("/v1/responses");

	api.answers.push({ status: 403, json: { error: { message: "client not allowed" } } });
	const { session: forced } = await start({}, "legacy");
	const refused = await turn(forced);
	expect(refused.find((event) => event.type === "error")).toMatchObject({ code: "api_error" });
	expect(api.requests.at(-1)?.path).toBe("/codex/responses");
});

it("stops at the subscription's usage limit, saying when it resets, and hides the tokens in any message", async () => {
	await signInLegacy();
	api.answers.push({
		status: 429,
		json: { error: { code: "usage_limit_reached", plan_type: "PRO", message: "limit" } },
	});
	const { session } = await start();
	const events = await turn(session);
	expect(events.find((event) => event.type === "error")).toMatchObject({ code: "usage_limit", recoverable: false });
	expect((events.find((event) => event.type === "error") as { message: string }).message).toMatch(/pro plan/);

	api.answers.push({ status: 400, json: { error: { message: `bad token ${legacy.access}` } } });
	const leaked = (await turn(session, "again")).find((event) => event.type === "error") as { message: string };
	expect(leaked.message).toContain("[redacted]");
	expect(leaked.message).not.toContain(legacy.access);
});

it("is built by name, with the variant ATELIER_CODEX_VARIANT forces, and refuses a variant it does not know", async () => {
	const backend = await createBackend("openai-codex", { openaiCodex: { store }, env: {} });
	expect(backend.id).toBe("openai-codex");
	await expect(
		createBackend("openai-codex", { openaiCodex: { store }, env: { ATELIER_CODEX_VARIANT: "beta" } }),
	).rejects.toThrow("ATELIER_CODEX_VARIANT must be legacy or chatgpt");
	await signInLegacy();
	await signInChatGpt();
	api.answers.push({ events: completed([textItem("ok")]) });
	const forced = await createBackend("openai-codex", {
		openaiCodex: { store, codexUrl: api.url, openaiUrl: `${api.url}/v1`, baseDelayMs: 0 },
		env: { ATELIER_CODEX_VARIANT: "chatgpt" },
	});
	const session = await forced.start({
		cwd: "/w",
		systemPromptAppend: "",
		tools: [],
		executeTool: async () => ({ ok: true, output: "" }),
	});
	await turn(session);
	expect(api.requests[0]?.path).toBe("/v1/responses");
});
