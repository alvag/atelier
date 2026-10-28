import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** A request the fake auth server received: its path and its form or JSON body. */
export interface AuthRequest {
	path: string;
	body: Record<string, string>;
}

/** What the fake server answers on a path, from the request's body; `undefined` sends a 404. */
export type AuthRoute = (body: Record<string, string>) => { status?: number; json: unknown } | undefined;

/** A token shaped like OpenAI's, built at run time so no test holds a literal that looks like a real one. */
export function fakeJwt(claims: Record<string, unknown>): string {
	const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${part({ alg: "none" })}.${part(claims)}.${Buffer.from(randomUUID()).toString("base64url")}`;
}

/** An access token for a ChatGPT account, with the account id where Codex reads it. */
export function fakeCodexAccess(accountId: string): string {
	return fakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } });
}

export const fakeRefresh = (): string => `test-refresh-${randomUUID()}`;

async function readBody(request: IncomingMessage): Promise<Record<string, string>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	const text = Buffer.concat(chunks).toString("utf8");
	if (text === "") return {};
	if ((request.headers["content-type"] ?? "").includes("json")) return JSON.parse(text) as Record<string, string>;
	return Object.fromEntries(new URLSearchParams(text));
}

/** A local stand-in for auth.openai.com: each path answers with its route, and every request is kept. */
export class FakeOpenAiAuth {
	readonly requests: AuthRequest[] = [];
	readonly routes = new Map<string, AuthRoute>();
	#server: Server | undefined;
	#url = "";

	get url(): string {
		return this.#url;
	}

	async start(): Promise<this> {
		this.#server = createServer((request, response) => void this.#answer(request, response));
		await new Promise<void>((resolve) => this.#server?.listen(0, "127.0.0.1", resolve));
		this.#url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
		return this;
	}

	async stop(): Promise<void> {
		this.#server?.closeAllConnections();
		await new Promise((resolve) => this.#server?.close(resolve));
	}

	async #answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const path = new URL(request.url ?? "/", this.#url).pathname;
		const body = await readBody(request);
		this.requests.push({ path, body });
		const answer = this.routes.get(path)?.(body);
		if (answer === undefined) return void response.writeHead(404).end();
		response.writeHead(answer.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(answer.json));
	}
}
