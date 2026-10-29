import type { AtelierEventBody, BackendName } from "@atelier/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requireIsolatedHome } from "../../atelier-core/test/support/login-isolation.ts";
import { cliBackends } from "../src/backends.ts";

requireIsolatedHome();

beforeEach(() => {
	// Every request fails: the turn still says the context it would compact at.
	vi.stubGlobal("fetch", async () => {
		throw new Error("No network allowed");
	});
	vi.stubEnv("ANTHROPIC_API_KEY", "inert-test-key");
	vi.stubEnv("OPENCODE_API_KEY", "inert-test-key");
	vi.stubEnv("ATELIER_LOGIN_CHECK", "off");
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

it.each(["anthropic-api", "opencode-go", "openai-codex"] satisfies BackendName[])(
	"compacts %s at ATELIER_COMPACT_AT, as the core server does",
	async (name) => {
		const backend = await cliBackends({ compactAt: 100_000 })(name);
		const session = await backend.start({
			cwd: process.cwd(),
			systemPromptAppend: "",
			tools: [],
			executeTool: async () => ({ ok: true, output: "" }),
		});
		const events: AtelierEventBody[] = [];
		for await (const event of session.send("hi")) events.push(event);
		await session.close();
		expect(events.find((event) => event.type === "turn_finished")).toMatchObject({
			context: { compactAt: 100_000 },
		});
	},
);
