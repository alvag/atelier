import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AuthStore, authFile } from "../src/auth-store.ts";
import type { BackendSession, BackendStartOptions } from "../src/backend.ts";
import { OpenAiCodexBackend } from "../src/backends/openai-codex/backend.ts";
import { SUMMARY_HEADINGS } from "../src/compaction/compactor.ts";
import type { AtelierEventBody } from "../src/events.ts";
import { fakeCodexAccess, fakeRefresh } from "./support/fake-openai-auth.ts";
import { callItem, completed, FakeResponses, textItem } from "./support/fake-responses.ts";
import { requireIsolatedHome } from "./support/login-isolation.ts";

requireIsolatedHome();

const SUMMARY = SUMMARY_HEADINGS.map((heading) => `${heading}\n- noted`).join("\n");
const big = { input_tokens: 1_000, output_tokens: 10 };
const small = { input_tokens: 10, output_tokens: 5 };

let home: string;
let api: FakeResponses;
let store: AuthStore;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "atelier-codex-compaction-"));
	api = await new FakeResponses().start();
	store = new AuthStore(authFile(home));
	const accountId = `acct-${randomUUID()}`;
	await store.set("openai-codex", {
		type: "oauth",
		access: fakeCodexAccess(accountId),
		refresh: fakeRefresh(),
		expires: Date.now() + 3_600_000,
		accountId,
	} as never);
});

afterEach(async () => {
	await api.stop();
	await rm(home, { recursive: true, force: true });
});

async function start(options: Partial<BackendStartOptions> = {}, compactAt = 50) {
	const summaries: string[] = [];
	const backend = new OpenAiCodexBackend({
		store,
		codexUrl: api.url,
		baseDelayMs: 0,
		compactAt,
		keepRecentTokens: 1,
	});
	const session = await backend.start({
		cwd: "/work",
		systemPromptAppend: "",
		tools: [],
		executeTool: async () => ({ ok: true, output: "contents" }),
		compactionState: () => "Active feature: none.",
		compacted: (summary) => summaries.push(summary),
		...options,
	});
	return { session, summaries };
}

async function all(events: AsyncIterable<AtelierEventBody> | Iterable<AtelierEventBody>): Promise<AtelierEventBody[]> {
	const seen: AtelierEventBody[] = [];
	for await (const event of events) seen.push(event);
	return seen;
}

const inputOf = (request: { body: Record<string, unknown> } | undefined) => (request?.body.input ?? []) as unknown[];

const userText = (item: unknown) =>
	((item as { content?: { text?: string }[] }).content ?? []).map((part) => part.text ?? "").join("");

/** Two turns: the first reads a file with a tool, the second answers; the last response reports `lastUsage`. */
async function twoTurns(session: BackendSession, lastUsage = small): Promise<void> {
	api.answers.push({ events: completed([callItem("call_1", "read", { path: "src/a.ts" })], small) });
	api.answers.push({ events: completed([textItem("read it")], small) });
	await all(session.send("read a"));
	api.answers.push({ events: completed([textItem("ok")], lastUsage) });
	await all(session.send("second"));
}

it("compacts at the threshold: the summary replaces the older history, with the files and the core's state", async () => {
	const { session, summaries } = await start({}, 200);
	await twoTurns(session, big);
	expect(api.requests).toHaveLength(3);
	api.answers.push({ events: completed([textItem(SUMMARY)], { input_tokens: 900, output_tokens: 50 }) });
	api.answers.push({ events: completed([textItem("third")]) });
	const events = await all(session.send("third"));
	expect(events.find((event) => event.type === "compaction_started")).toMatchObject({ reason: "threshold" });
	expect(events.find((event) => event.type === "compaction_finished")).toMatchObject({ ok: true, reason: "threshold" });
	const [summaryRequest, turnRequest] = api.requests.slice(-2);
	expect(summaryRequest?.body.tool_choice).toBe("none");
	expect(userText(inputOf(summaryRequest).at(-1))).toContain("Summarize the conversation above");
	const input = inputOf(turnRequest);
	const compacted = userText(input[0]);
	expect(compacted).toContain(`<summary>\n${SUMMARY}\n</summary>`);
	expect(compacted).toContain("Read: src/a.ts");
	expect(compacted).toContain("Active feature: none.");
	expect(userText(input.at(-1))).toBe("third");
	expect(input.length).toBeLessThan(7);
	expect(summaries).toEqual([SUMMARY]);
	expect(events.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "end_turn", requests: 2 });
});

it("compacts once on a context overflow and retries the request", async () => {
	const { session } = await start({}, 1_000_000);
	await twoTurns(session);
	api.answers.push({ status: 400, json: { error: { code: "context_length_exceeded", message: "too long" } } });
	api.answers.push({ events: completed([textItem(SUMMARY)]) });
	api.answers.push({ events: completed([textItem("after")]) });
	const events = await all(session.send("third"));
	expect(events.find((event) => event.type === "compaction_started")).toMatchObject({ reason: "overflow" });
	expect(events.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "end_turn" });
	expect(userText(inputOf(api.requests.at(-1))[0])).toContain("<summary>");
});

it("keeps the history when the summary lacks a section, and compacts by hand with instructions", async () => {
	const { session } = await start({}, 1_000_000);
	await twoTurns(session);
	api.answers.push({ events: completed([textItem("## Goal\nonly this")]) });
	const failed = await all(session.compact?.("keep the paths") ?? []);
	expect(failed.find((event) => event.type === "compaction_finished")).toMatchObject({ ok: false, reason: "manual" });
	expect(failed.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "error" });
	expect(userText(inputOf(api.requests.at(-1)).at(-1))).toContain("keep the paths");

	api.answers.push({ events: completed([textItem(SUMMARY)]) });
	const done = await all(session.compact?.() ?? []);
	expect(done.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "end_turn" });
	expect(((session.resumeState?.() ?? { messages: [] }) as { messages: unknown[] }).messages.length).toBeLessThan(6);
});

it("summarizes the whole conversation for another backend, on the compaction's model, leaving the history as it is", async () => {
	const { session } = await start({ compaction: { model: "gpt-6-luna", thinking: "low" } }, 1_000_000);
	await twoTurns(session);
	const history = session.resumeState?.();
	api.answers.push({ events: completed([textItem(SUMMARY)], { input_tokens: 40, output_tokens: 8 }) });
	const summary = await session.summarize?.();
	expect(summary?.text).toBe(`${SUMMARY}\n\n## Files\nRead: src/a.ts\nEdited: (none)`);
	expect(summary?.usage).toEqual({ input: 40, output: 8, cacheRead: 0, cacheWrite: 0 });
	expect(api.requests.at(-1)?.body).toMatchObject({
		model: "gpt-6-luna",
		reasoning: { effort: "low" },
		tool_choice: "none",
	});
	expect(session.resumeState?.()).toEqual(history);
});
