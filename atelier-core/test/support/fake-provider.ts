import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** A request the fake provider received. */
export interface Received {
	method: string;
	path: string;
	headers: IncomingHttpHeaders;
	body: Record<string, unknown>;
}

/** What the fake answers: an event stream, or a status with a JSON body. */
export type Answer = { sse: string } | { status: number; json: unknown; headers?: Record<string, string> };

/** Server-sent events, one `data:` line each, with the `event:` line the Messages API adds. */
export function sse(events: readonly unknown[], options: { named?: boolean; done?: boolean } = {}): string {
	const lines = events.map((event) => {
		const name = options.named ? `event: ${(event as { type: string }).type}\n` : "";
		return `${name}data: ${JSON.stringify(event)}\n\n`;
	});
	return lines.join("") + (options.done ? "data: [DONE]\n\n" : "");
}

/**
 * A provider on 127.0.0.1 that answers each request with the next scripted answer and records what it got, so tests
 * see the requests as the network would carry them, without leaving the machine.
 */
export class FakeProvider {
	readonly received: Received[] = [];
	readonly #answers: Answer[] = [];
	readonly #server: Server;

	private constructor(server: Server) {
		this.#server = server;
	}

	static async start(): Promise<FakeProvider> {
		const server = createServer();
		const provider = new FakeProvider(server);
		server.on("request", (request, response) => {
			let raw = "";
			request.on("data", (chunk) => {
				raw += chunk;
			});
			request.on("end", () => {
				provider.received.push({
					method: request.method ?? "",
					path: request.url ?? "",
					headers: request.headers,
					body: raw === "" ? {} : JSON.parse(raw),
				});
				const answer = provider.#answers.shift() ?? { status: 500, json: { error: "nothing scripted" } };
				if ("sse" in answer) {
					response.writeHead(200, { "content-type": "text/event-stream" });
					response.end(answer.sse);
					return;
				}
				response.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
				response.end(JSON.stringify(answer.json));
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		return provider;
	}

	get url(): string {
		return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
	}

	answer(...answers: Answer[]): void {
		this.#answers.push(...answers);
	}

	async close(): Promise<void> {
		this.#server.closeAllConnections();
		await new Promise<void>((resolve) => this.#server.close(() => resolve()));
	}
}
