import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** One answer of the fake Responses API: a stream of events, or a status with a JSON body. */
export type FakeAnswer =
	| { events: Record<string, unknown>[]; status?: undefined }
	| { status: number; json?: unknown; headers?: Record<string, string> };

export interface ResponsesRequestSeen {
	path: string;
	headers: IncomingHttpHeaders;
	body: Record<string, unknown>;
}

/** A finished response's events: the items as `output_item.done`, then `response.completed` with the usage. */
export function completed(
	items: Record<string, unknown>[],
	usage: Record<string, unknown> = { input_tokens: 10, output_tokens: 5 },
): Record<string, unknown>[] {
	return [
		...items.map((item) => ({ type: "response.output_item.done", item })),
		{ type: "response.completed", response: { status: "completed", usage } },
	];
}

export const textItem = (text: string): Record<string, unknown> => ({
	type: "message",
	role: "assistant",
	content: [{ type: "output_text", text }],
});

export const callItem = (callId: string, name: string, input: unknown): Record<string, unknown> => ({
	type: "function_call",
	call_id: callId,
	name,
	arguments: JSON.stringify(input),
});

/** A local stand-in for a Responses endpoint: answers each request with the next queued answer. */
export class FakeResponses {
	readonly requests: ResponsesRequestSeen[] = [];
	readonly answers: FakeAnswer[] = [];
	#server: Server | undefined;
	#url = "";

	get url(): string {
		return this.#url;
	}

	async start(): Promise<this> {
		this.#server = createServer(async (request, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(chunk as Buffer);
			const text = Buffer.concat(chunks).toString("utf8");
			this.requests.push({
				path: new URL(request.url ?? "/", this.#url).pathname,
				headers: request.headers,
				body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
			});
			const answer = this.answers.shift() ?? { status: 500, json: { error: { message: "no answer queued" } } };
			if (answer.status !== undefined) {
				response.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
				return void response.end(answer.json === undefined ? "" : JSON.stringify(answer.json));
			}
			response.writeHead(200, { "content-type": "text/event-stream" });
			for (const event of answer.events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			response.end();
		});
		await new Promise<void>((resolve) => this.#server?.listen(0, "127.0.0.1", resolve));
		this.#url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
		return this;
	}

	async stop(): Promise<void> {
		this.#server?.closeAllConnections();
		await new Promise((resolve) => this.#server?.close(resolve));
	}
}
