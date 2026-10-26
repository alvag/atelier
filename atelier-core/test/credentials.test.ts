import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBackend } from "../src/backend-factory.ts";
import { AnthropicApiBackend } from "../src/backends/anthropic-api/backend.ts";
import { ClaudeCodeBackend } from "../src/backends/claude-code/backend.ts";
import {
	KEYCHAIN_SERVICE,
	KeychainError,
	MissingApiKeyError,
	resolveApiKey,
	type SecurityResult,
} from "../src/credentials.ts";
import { decodeServerMessage, FakeBackend, RpcServer, type ServerMessage } from "../src/index.ts";
import { bashTool } from "../src/tools/index.ts";

const KEY = "sk-ant-api-SECRET-xyz";

function security(result: SecurityResult) {
	const calls: string[][] = [];
	return {
		calls,
		run: async (args: readonly string[]) => {
			calls.push([...args]);
			return result;
		},
	};
}

describe("resolveApiKey", () => {
	it("reads the key from the macOS Keychain, trimming the trailing newline", async () => {
		const keychain = security({ code: 0, stdout: `${KEY}\n`, stderr: "" });
		await expect(resolveApiKey({ env: {}, platform: "darwin", runSecurity: keychain.run })).resolves.toBe(KEY);
		expect(keychain.calls).toEqual([["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]]);
		expect(KEYCHAIN_SERVICE).toBe("atelier-anthropic");
	});

	it("prefers ANTHROPIC_API_KEY set for the command and then skips the Keychain", async () => {
		const keychain = security({ code: 0, stdout: "other", stderr: "" });
		await expect(
			resolveApiKey({ env: { ANTHROPIC_API_KEY: ` ${KEY} ` }, platform: "darwin", runSecurity: keychain.run }),
		).resolves.toBe(KEY);
		expect(keychain.calls).toEqual([]);
	});

	it("ignores an empty ANTHROPIC_API_KEY", async () => {
		const keychain = security({ code: 0, stdout: KEY, stderr: "" });
		await expect(
			resolveApiKey({ env: { ANTHROPIC_API_KEY: "  " }, platform: "darwin", runSecurity: keychain.run }),
		).resolves.toBe(KEY);
	});

	it("explains how to store the key when the Keychain has none", async () => {
		const keychain = security({
			code: 44,
			stdout: "",
			stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
		});
		const error = await resolveApiKey({ env: {}, platform: "darwin", runSecurity: keychain.run }).catch((e) => e);
		expect(error).toBeInstanceOf(MissingApiKeyError);
		expect(error.code).toBe("missing_api_key");
		expect(error.message).toContain(`security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a "$USER" -w`);
	});

	it("treats an empty Keychain entry as missing", async () => {
		const keychain = security({ code: 0, stdout: "\n", stderr: "" });
		await expect(resolveApiKey({ env: {}, platform: "darwin", runSecurity: keychain.run })).rejects.toBeInstanceOf(
			MissingApiKeyError,
		);
	});

	it("never puts stdout in the message, whether the key is missing or the Keychain fails", async () => {
		for (const [code, expected] of [
			[
				44,
				`No Anthropic API key in the Keychain. Store it with: security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a "$USER" -w`,
			],
			[51, "The Keychain could not be read (security exit 51): denied"],
		] as const) {
			const keychain = security({ code, stdout: KEY, stderr: "denied" });
			const error = await resolveApiKey({ env: {}, platform: "darwin", runSecurity: keychain.run }).catch((e) => e);
			expect(error.message).toBe(expected);
		}
	});

	it("reports other Keychain failures with stderr but never stdout", async () => {
		const keychain = security({ code: 51, stdout: KEY, stderr: "User interaction is not allowed." });
		const error = await resolveApiKey({ env: {}, platform: "darwin", runSecurity: keychain.run }).catch((e) => e);
		expect(error).toBeInstanceOf(KeychainError);
		expect(error.code).toBe("keychain_error");
		expect(error.message).toContain("User interaction is not allowed.");
		expect(error.message).not.toContain(KEY);
	});

	it("asks for ANTHROPIC_API_KEY outside macOS, without running security", async () => {
		const keychain = security({ code: 0, stdout: KEY, stderr: "" });
		const error = await resolveApiKey({ env: {}, platform: "linux", runSecurity: keychain.run }).catch((e) => e);
		expect(error).toBeInstanceOf(MissingApiKeyError);
		expect(error.message).toContain("ANTHROPIC_API_KEY");
		expect(keychain.calls).toEqual([]);
	});
});

describe("createBackend", () => {
	it("keeps the resolved key out of the environment and out of error events", async () => {
		const before = { ...process.env };
		const backend = await createBackend("anthropic-api", {
			resolveApiKey: async () => KEY,
			anthropicApi: {
				maxRetries: 0,
				fetch: async (_url, init) => {
					expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
					return new Response(
						JSON.stringify({
							type: "error",
							error: { type: "authentication_error", message: `Bearer ${KEY}; ${KEY}` },
						}),
						{ status: 401, headers: { "content-type": "application/json" } },
					);
				},
			},
		});
		const session = await backend.start({
			cwd: process.cwd(),
			tools: [],
			systemPromptAppend: "",
			executeTool: async () => ({ ok: true, output: "" }),
		});
		try {
			const events = [];
			for await (const event of session.send("hello")) events.push(event);
			expect(events).toContainEqual(expect.objectContaining({ type: "error", code: "authentication_error" }));
			expect(JSON.stringify(events)).not.toContain(KEY);
			expect(process.env).toEqual(before);
		} finally {
			await session.close();
		}
	});

	it("builds Claude Code without reading any key", async () => {
		let reads = 0;
		const backend = await createBackend("claude-code", {
			resolveApiKey: async () => {
				reads++;
				return KEY;
			},
		});
		expect(backend).toBeInstanceOf(ClaudeCodeBackend);
		expect(reads).toBe(0);
	});

	it("builds the anthropic-api backend with the resolved key", async () => {
		const backend = await createBackend("anthropic-api", { resolveApiKey: async () => KEY });
		expect(backend).toBeInstanceOf(AnthropicApiBackend);
		expect(backend.id).toBe("anthropic-api");
	});

	it("lets a missing key fail the start", async () => {
		await expect(
			createBackend("anthropic-api", {
				resolveApiKey: async () => {
					throw new MissingApiKeyError("none");
				},
			}),
		).rejects.toBeInstanceOf(MissingApiKeyError);
	});
});

describe("session.start backend selection", () => {
	let cwd: string;
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "atelier-backend-"));
	});
	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	function server(createBackendFor: ConstructorParameters<typeof RpcServer>[0]["createBackend"]) {
		const input = new PassThrough();
		const messages: ServerMessage[] = [];
		void new RpcServer({
			input,
			write: (line) => messages.push(decodeServerMessage(line.trimEnd()) as ServerMessage),
			createBackend: createBackendFor,
			tools: [],
			systemPromptAppend: "",
			home: cwd,
		}).run();
		const response = async (command: Record<string, unknown>) => {
			input.write(`${JSON.stringify({ type: "command", id: "s", command: "session.start", cwd, ...command })}\n`);
			for (let i = 0; i < 100; i++) {
				const found = messages.find((m) => m.type === "response");
				if (found) return found;
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			throw new Error("No response");
		};
		return { response, close: () => input.end() };
	}

	it("passes the requested backend, claude-code by default", async () => {
		const names: string[] = [];
		const make = (name: string) => {
			names.push(name);
			return new FakeBackend([]);
		};
		const first = server(make);
		expect(await first.response({ backend: "anthropic-api" })).toMatchObject({ ok: true });
		first.close();
		const second = server(make);
		expect(await second.response({})).toMatchObject({ ok: true });
		second.close();
		expect(names).toEqual(["anthropic-api", "claude-code"]);
	});

	it("answers missing_api_key with the instructions", async () => {
		const s = server(async () => {
			throw new MissingApiKeyError("No Anthropic API key. Store it with: security add-generic-password ...");
		});
		expect(await s.response({ backend: "anthropic-api" })).toEqual({
			type: "response",
			id: "s",
			ok: false,
			error: {
				code: "missing_api_key",
				message: "No Anthropic API key. Store it with: security add-generic-password ...",
			},
		});
		s.close();
	});

	it("answers keychain_error when the Keychain fails", async () => {
		const s = server(async () => {
			throw new KeychainError("The Keychain could not be read: denied");
		});
		expect(await s.response({ backend: "anthropic-api" })).toMatchObject({
			ok: false,
			error: { code: "keychain_error" },
		});
		s.close();
	});

	it("rejects an unknown backend as an invalid command", async () => {
		const s = server(() => new FakeBackend([]));
		expect(await s.response({ backend: "openai" })).toMatchObject({ ok: false, error: { code: "invalid_command" } });
		s.close();
	});
});

describe("bash environment", () => {
	const saved = { api: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
	afterEach(() => {
		for (const [name, value] of [
			["ANTHROPIC_API_KEY", saved.api],
			["ANTHROPIC_AUTH_TOKEN", saved.token],
		] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		delete process.env.ATELIER_TEST_VISIBLE;
	});

	it("hides Anthropic credentials from commands the model runs and keeps everything else", async () => {
		process.env.ANTHROPIC_API_KEY = KEY;
		process.env.ANTHROPIC_AUTH_TOKEN = "token-SECRET";
		process.env.ATELIER_TEST_VISIBLE = "still here";
		const outcome = await bashTool.execute(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template.
			{ command: 'echo "${ANTHROPIC_API_KEY-unset} ${ANTHROPIC_AUTH_TOKEN-unset} $ATELIER_TEST_VISIBLE"' },
			{ cwd: tmpdir() },
		);
		expect(outcome.ok).toBe(true);
		expect(outcome.output).toContain("unset unset still here");
		expect(outcome.output).not.toContain("SECRET");
		expect(process.env.ANTHROPIC_API_KEY).toBe(KEY);
	});
});
