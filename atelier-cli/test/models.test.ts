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

it("prints each backend's models: the code's, then the ones its provider listed, from the cache only", async () => {
	await mkdir(join(home, ".atelier"), { recursive: true });
	const listed = { checkedAt: Date.UTC(2026, 9, 28, 21, 0), models: { "opencode-go": [{ id: "grok-4.7" }] } };
	await writeFile(
		join(home, ".atelier", "models.json"),
		JSON.stringify({ version: 1, sources: { "opencode-go": listed } }),
	);
	const { code, out, err } = await models([]);
	expect({ code, err }).toEqual({ code: 0, err: "" });
	expect(out).toContain("claude-code · the code's list\n  opus\n  sonnet\n  haiku\n");
	expect(out).toContain("opencode-go · listed 2026-10-28T21:00:00.000Z\n  minimax-m3\n");
	expect(out).toContain("  grok-4.7  (new)\n");
	expect(out).toContain("openai-codex · the code's list\n  gpt-6-sol\n");
});

it("prints the code's lists when the cache holds a check time that is not a date", async () => {
	await mkdir(join(home, ".atelier"), { recursive: true });
	// As written in the file: the number is out of a date's range.
	const listed = '{"checkedAt":9999999999999999,"models":{"opencode-go":[{"id":"grok-4.7"}]}}';
	await writeFile(join(home, ".atelier", "models.json"), `{"version":1,"sources":{"opencode-go":${listed}}}`);
	const { code, out, err } = await models([]);
	expect({ code, err }).toEqual({ code: 0, err: "" });
	expect(out).toContain("opencode-go · the code's list\n  minimax-m3\n");
	expect(out).not.toContain("grok-4.7");
});

it("asks nothing with ATELIER_MODEL_REFRESH=off, and says so", async () => {
	const { code, out } = await models(["--refresh"], { ATELIER_MODEL_REFRESH: "off" });
	expect(code).toBe(0);
	expect(out.split("\n")[0]).toBe("ATELIER_MODEL_REFRESH=off: nothing was asked.");
	expect(out).toContain("anthropic-api · the code's list\n");
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
