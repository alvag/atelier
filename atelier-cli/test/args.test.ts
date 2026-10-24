import { describe, expect, it } from "vitest";
import { parseCliArgs, USAGE, UsageError } from "../src/args.ts";

describe("parseCliArgs", () => {
	it("joins positional words into one prompt", () => {
		expect(parseCliArgs(["fix", "the tests"], "/home")).toEqual({
			prompt: "fix the tests",
			yes: false,
			backend: "claude-code",
			cwd: "/home",
			help: false,
			version: false,
			review: true,
		});
	});

	it("starts an interactive session without a prompt", () => {
		expect(parseCliArgs([], "/home").prompt).toBeUndefined();
	});

	it("reads --yes, --model and --cwd", () => {
		expect(parseCliArgs(["--yes", "--model", "sonnet", "--cwd", "./other", "do it"], "/home")).toEqual({
			prompt: "do it",
			yes: true,
			model: "sonnet",
			backend: "claude-code",
			cwd: "/home/other",
			help: false,
			version: false,
			review: true,
		});
		expect(parseCliArgs(["-y", "x"], "/home").yes).toBe(true);
	});

	it("reads --backend, claude-code by default", () => {
		expect(parseCliArgs(["--backend", "anthropic-api", "x"], "/h").backend).toBe("anthropic-api");
		expect(parseCliArgs(["x"], "/h").backend).toBe("claude-code");
	});

	it("reviews changes unless --no-review or ATELIER_REVIEW=off", () => {
		expect(parseCliArgs(["x"], "/h").review).toBe(true);
		expect(parseCliArgs(["--no-review", "x"], "/h").review).toBe(false);
		expect(parseCliArgs(["x"], "/h", { ATELIER_REVIEW: "off" }).review).toBe(false);
		expect(parseCliArgs(["x"], "/h", { ATELIER_REVIEW: "on" }).review).toBe(true);
		expect(parseCliArgs(["--no-review", "x"], "/h", {}).review).toBe(false);
	});

	it("runs bash in the sandbox unless --no-sandbox or ATELIER_SANDBOX=off", () => {
		expect(parseCliArgs(["x"], "/h").noSandbox).toBeUndefined();
		expect(parseCliArgs(["--no-sandbox", "x"], "/h").noSandbox).toBe(true);
		expect(parseCliArgs(["x"], "/h", { ATELIER_SANDBOX: "off" }).noSandbox).toBe(true);
		expect(parseCliArgs(["x"], "/h", { ATELIER_SANDBOX: "on" }).noSandbox).toBeUndefined();
		expect(parseCliArgs(["--no-sandbox", "x"], "/h", {}).noSandbox).toBe(true);
	});

	it("documents both ways to turn the sandbox off in the help", () => {
		expect(USAGE).toContain("--no-sandbox");
		expect(USAGE).toContain("ATELIER_SANDBOX=off");
	});

	it("documents both ways to turn the review off in the help", () => {
		expect(USAGE).toContain("--no-review");
		expect(USAGE).toContain("ATELIER_REVIEW=off");
		expect(USAGE).toContain("/review <ref>");
		expect(USAGE).toContain("/compact [instructions]");
		expect(USAGE).toContain("ATELIER_COMPACT_AT=<n>");
	});

	it("reads --help and --version", () => {
		expect(parseCliArgs(["--help"], "/h").help).toBe(true);
		expect(parseCliArgs(["-h"], "/h").help).toBe(true);
		expect(parseCliArgs(["--version"], "/h").version).toBe(true);
	});

	it.each([
		[["--nope"], /Unknown option '--nope'/],
		[["--model"], /--model/],
		[["--model", ""], /--model needs a value/],
		[["--backend", "openai"], /--backend must be claude-code or anthropic-api/],
		[["   "], /The prompt is empty/],
	])("rejects %j", (argv, message) => {
		expect(() => parseCliArgs(argv, "/h")).toThrow(UsageError);
		expect(() => parseCliArgs(argv, "/h")).toThrow(message);
	});
});
