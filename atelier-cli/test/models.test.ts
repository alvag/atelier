import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it } from "vitest";
import { run } from "../src/run.ts";

let home: string;
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "atelier-cli-models-"));
});
afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

async function models(argv: string[], env: Record<string, string> = {}) {
	let out = "";
	let err = "";
	const code = await run(["models", ...argv], {
		stdin: new PassThrough(),
		isTTY: false,
		stdout: (text) => {
			out += text;
		},
		stderr: (text) => {
			err += text;
		},
		cwd: "/work",
		home,
		env,
		color: false,
	});
	return { code, out, err };
}

it("prints each backend's models, the code's and the ones its provider listed, newest first, from the cache only", async () => {
	await mkdir(join(home, ".atelier"), { recursive: true });
	const listed = { checkedAt: Date.UTC(2026, 9, 28, 21, 0), models: { "opencode-go": [{ id: "grok-4.7" }] } };
	await writeFile(
		join(home, ".atelier", "models.json"),
		JSON.stringify({ version: 1, sources: { "opencode-go": listed } }),
	);
	const { code, out, err } = await models([]);
	expect({ code, err }).toEqual({ code: 0, err: "" });
	expect(out).toContain("claude-code · the code's list\n  claude-opus-5-5\n  claude-sonnet-5-5\n  claude-haiku-5-5\n");
	expect(out).toContain("opencode-go · listed 2026-10-28T21:00:00.000Z\n");
	expect(out).toContain("  grok-4.7  (new)\n");
	expect(out).toContain("openai-codex · the code's list\n  gpt-6.1-sol\n  gpt-6-sol\n");
});

it("says a model's long name, its window and whether it takes images, where the catalog knows them", async () => {
	await mkdir(join(home, ".atelier"), { recursive: true });
	const sources = {
		"models.dev": {
			checkedAt: 1,
			models: {
				"anthropic-api": [{ id: "claude-sonnet-5-5", images: true }],
				"claude-code": [{ id: "claude-opus-5-5", name: "Claude Opus 5.5", images: true }],
				"opencode-go": [{ id: "grok-4.7", images: false }],
			},
		},
		"opencode-go": { checkedAt: 1, models: { "opencode-go": [{ id: "grok-4.7" }] } },
		"claude-code": {
			checkedAt: 1,
			models: { "claude-code": [{ id: "claude-opus-5-5", aliases: ["opus"], contextWindow: 1_000_000 }] },
		},
	};
	await writeFile(join(home, ".atelier", "models.json"), JSON.stringify({ version: 1, sources }));
	const { code, out } = await models([]);
	expect(code).toBe(0);
	expect(out).toContain("  claude-opus-5-5  Claude Opus 5.5 · 1M context · images\n");
	expect(out).toContain("  claude-sonnet-5-5  images\n");
	expect(out).toContain("  grok-4.7  (new)  text only\n");
	expect(out).toContain("  claude-opus-5-5\n");
});

it("prints the code's lists when the cache holds a check time that is not a date", async () => {
	await mkdir(join(home, ".atelier"), { recursive: true });
	// As written in the file: the number is out of a date's range.
	const listed = '{"checkedAt":9999999999999999,"models":{"opencode-go":[{"id":"grok-4.7"}]}}';
	await writeFile(join(home, ".atelier", "models.json"), `{"version":1,"sources":{"opencode-go":${listed}}}`);
	const { code, out, err } = await models([]);
	expect({ code, err }).toEqual({ code: 0, err: "" });
	expect(out).toContain("opencode-go · the code's list\n");
	expect(out).toContain("  minimax-m3\n");
	expect(out).not.toContain("grok-4.7");
});

it("asks nothing with ATELIER_MODEL_REFRESH=off, and says so", async () => {
	const { code, out } = await models(["--refresh"], { ATELIER_MODEL_REFRESH: "off" });
	expect(code).toBe(0);
	expect(out.split("\n")[0]).toBe("ATELIER_MODEL_REFRESH=off: nothing was asked.");
	expect(out).toContain("anthropic-api · the code's list\n");
});

it("asks nothing offline (ATELIER_OFFLINE=1), even with --refresh, and says so", async () => {
	const { code, out } = await models(["--refresh"], { ATELIER_OFFLINE: "1" });
	expect(code).toBe(0);
	expect(out.split("\n")[0]).toBe("ATELIER_OFFLINE=1: nothing was asked.");
	expect(out).not.toContain("Refreshed");
});

it("takes only --refresh, and --refresh only with models", async () => {
	expect(await models(["now"])).toMatchObject({ code: 2 });
	expect((await models(["--json"])).code).toBe(2);
	const other = await run(["--refresh"], {
		stdin: new PassThrough(),
		isTTY: false,
		stdout: () => {},
		stderr: () => {},
		cwd: "/work",
		home,
		color: false,
	});
	expect(other).toBe(2);
});

it("shows a name or an id from a source with markers for escape sequences and control characters", async () => {
	await mkdir(join(home, ".atelier"), { recursive: true });
	const sources = {
		"models.dev": {
			checkedAt: 1,
			models: { "opencode-go": [{ id: "grok-\u001b[2Jx", name: "Grok\u0007 \u001b]0;owned\u0007" }] },
		},
		"opencode-go": { checkedAt: 1, models: { "opencode-go": [{ id: "grok-\u001b[2Jx" }] } },
	};
	await writeFile(join(home, ".atelier", "models.json"), JSON.stringify({ version: 1, sources }));
	const { code, out } = await models([]);
	expect(code).toBe(0);
	expect([...out].filter((char) => char !== "\n" && (char < " " || char === "\u007f"))).toEqual([]);
	expect(out).toContain("  grok-␛[2Jx  (new)  Grok⟨U+0007⟩ ␛]0;owned⟨U+0007⟩\n");
});

it("rounds a window just under a million to 1M, not 1000K", async () => {
	await mkdir(join(home, ".atelier"), { recursive: true });
	const sources = {
		"opencode-go": {
			checkedAt: 1,
			models: {
				"opencode-go": [
					{ id: "edge-1", contextWindow: 999_950 },
					{ id: "edge-2", contextWindow: 999_499 },
				],
			},
		},
	};
	await writeFile(join(home, ".atelier", "models.json"), JSON.stringify({ version: 1, sources }));
	const { out } = await models([]);
	expect(out).toContain("  edge-1  (new)  1M context\n");
	expect(out).toContain("  edge-2  (new)  999.5K context\n");
});
