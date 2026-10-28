import { afterEach, beforeEach, expect, it } from "vitest";
import {
	buildResponsesBody,
	type ResponsesEndpoint,
	ResponsesError,
	type ResponsesEvent,
	streamResponse,
} from "../src/responses/client.ts";
import { callItem, completed, FakeResponses, textItem } from "./support/fake-responses.ts";

let api: FakeResponses;
let endpoint: ResponsesEndpoint;

beforeEach(async () => {
	api = await new FakeResponses().start();
	endpoint = {
		url: `${api.url}/v1/responses`,
		headers: async () => ({ authorization: "Bearer test" }),
		baseDelayMs: 0,
	};
});

afterEach(async () => {
	await api.stop();
});

const body = buildResponsesBody({
	model: "gpt-test",
	instructions: "Be brief.",
	input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
	tools: [{ type: "function", name: "read", description: "Reads", parameters: { type: "object" } }],
	reasoning: { effort: "high", summary: "auto" },
	promptCacheKey: "session-1",
});

async function collect(events: AsyncIterable<ResponsesEvent>): Promise<ResponsesEvent[]> {
	const all: ResponsesEvent[] = [];
	for await (const event of events) all.push(event);
	return all;
}

it("sends the request as a stream, without storing it, and reads text, reasoning, items and usage", async () => {
	const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque" };
	api.answers.push({
		events: [
			{ type: "response.reasoning_summary_text.delta", delta: "Think" },
			{ type: "response.output_text.delta", delta: "Hel" },
			{ type: "response.output_text.delta", delta: "lo" },
			...completed([reasoning, textItem("Hello"), callItem("call_1", "read", { path: "a" })], {
				input_tokens: 120,
				input_tokens_details: { cached_tokens: 100 },
				output_tokens: 30,
				output_tokens_details: { reasoning_tokens: 12 },
			}),
		],
	});
	const events = await collect(streamResponse(endpoint, body));
	expect(events).toEqual([
		{ type: "reasoning_delta", text: "Think" },
		{ type: "text_delta", text: "Hel" },
		{ type: "text_delta", text: "lo" },
		{
			type: "done",
			status: "completed",
			output: [reasoning, textItem("Hello"), callItem("call_1", "read", { path: "a" })],
			usage: { input: 20, cacheRead: 100, output: 30, reasoning: 12 },
		},
	]);
	expect(api.requests[0]?.headers.authorization).toBe("Bearer test");
	expect(api.requests[0]?.headers.accept).toBe("text/event-stream");
	expect(api.requests[0]?.body).toEqual({
		model: "gpt-test",
		instructions: "Be brief.",
		input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
		tools: [{ type: "function", name: "read", description: "Reads", parameters: { type: "object" }, strict: false }],
		tool_choice: "auto",
		parallel_tool_calls: true,
		reasoning: { effort: "high", summary: "auto" },
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: "session-1",
		store: false,
		stream: true,
	});
});

it("says a usage limit with the plan and when it resets, without retrying it", async () => {
	const resets = Math.round(Date.now() / 1000) + 30 * 60;
	api.answers.push({
		status: 429,
		json: { error: { code: "usage_limit_reached", message: "limit", plan_type: "PLUS", resets_at: resets } },
	});
	const error = await collect(streamResponse(endpoint, body)).catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(ResponsesError);
	expect((error as ResponsesError).kind).toBe("usage_limit");
	expect((error as Error).message).toMatch(/usage limit \(plus plan\).*30 min/i);
	expect(api.requests).toHaveLength(1);
});

it("retries a busy or failing server, then streams", async () => {
	api.answers.push({ status: 503, json: { error: { message: "overloaded" } } });
	api.answers.push({
		status: 429,
		json: { error: { code: "rate_limit_exceeded" } },
		headers: { "retry-after-ms": "0" },
	});
	api.answers.push({ events: completed([textItem("ok")]) });
	expect((await collect(streamResponse(endpoint, body))).at(-1)).toMatchObject({ type: "done" });
	expect(api.requests).toHaveLength(3);
});

it("names what failed: the token, a refused endpoint, a context too long, a failed response", async () => {
	const kindOf = async () =>
		((await collect(streamResponse(endpoint, body)).catch((caught: unknown) => caught)) as ResponsesError).kind;
	api.answers.push({ status: 401, json: { error: { message: "token expired" } } });
	expect(await kindOf()).toBe("auth");
	api.answers.push({ status: 403, json: { error: { message: "not allowed" } } });
	expect(await kindOf()).toBe("refused");
	api.answers.push({ status: 400, json: { error: { code: "context_length_exceeded", message: "too long" } } });
	expect(await kindOf()).toBe("overflow");
	api.answers.push({
		events: [
			{ type: "response.failed", response: { error: { code: "context_length_exceeded", message: "too long" } } },
		],
	});
	expect(await kindOf()).toBe("overflow");
	api.answers.push({ events: [{ type: "error", code: "server_error", message: "boom" }] });
	const error = (await collect(streamResponse(endpoint, { ...body })).catch((caught: unknown) => caught)) as Error;
	expect(error.message).toContain("boom");
});

it("reports a response cut short, with its reason", async () => {
	api.answers.push({
		events: [
			{ type: "response.output_item.done", item: textItem("par") },
			{
				type: "response.incomplete",
				response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
			},
		],
	});
	expect((await collect(streamResponse(endpoint, body))).at(-1)).toMatchObject({
		type: "done",
		status: "incomplete",
		incompleteReason: "max_output_tokens",
		output: [textItem("par")],
	});
});

it("sends no tools or reasoning when none are asked, and adds the endpoint's own fields", () => {
	expect(
		buildResponsesBody({ model: "m", instructions: "i", input: [], extra: { text: { verbosity: "low" } } }),
	).toEqual({
		model: "m",
		instructions: "i",
		input: [],
		tool_choice: "auto",
		parallel_tool_calls: true,
		store: false,
		stream: true,
		text: { verbosity: "low" },
	});
});

it("fails as the endpoint's headers fail, without sending or retrying the request", async () => {
	const refused = new Error("not signed in");
	let asked = 0;
	const failing: ResponsesEndpoint = {
		...endpoint,
		headers: async () => {
			asked++;
			throw refused;
		},
	};
	await expect(collect(streamResponse(failing, body))).rejects.toBe(refused);
	expect(asked).toBe(1);
	expect(api.requests).toHaveLength(0);
});

it("reads a stream whose lines end in CRLF, even split between chunks", async () => {
	const events = completed([textItem("done")]);
	const text = events.map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join("");
	// Every chunk boundary falls between a \r and its \n.
	const chunks = text.split(/(?<=\r)(?=\n)/);
	const crlf: ResponsesEndpoint = {
		url: "https://example.invalid/responses",
		headers: async () => ({}),
		fetch: async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
						controller.close();
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			),
	};
	expect(chunks.length).toBeGreaterThan(2);
	expect(await collect(streamResponse(crlf, body))).toEqual([
		expect.objectContaining({ type: "done", status: "completed", output: [textItem("done")] }),
	]);
});

it("reads a stream whose lines end in a bare CR, up to the CR that ends it", async () => {
	const events = completed([textItem("done")]);
	const text = events.map((event) => `data: ${JSON.stringify(event)}\r\r`).join("");
	const cr: ResponsesEndpoint = {
		url: "https://example.invalid/responses",
		headers: async () => ({}),
		fetch: async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						// Each event in a chunk of its own: every chunk, the last one too, ends in \r.
						for (const chunk of text.split(/(?<=\r\r)/)) controller.enqueue(new TextEncoder().encode(chunk));
						controller.close();
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			),
	};
	expect(await collect(streamResponse(cr, body))).toEqual([
		expect.objectContaining({ type: "done", status: "completed", output: [textItem("done")] }),
	]);
});
