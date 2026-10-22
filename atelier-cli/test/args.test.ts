import { describe, expect, it } from "vitest";
import { parseCliArgs, UsageError } from "../src/args.ts";

describe("parseCliArgs", () => {
	it("joins positional words into one prompt", () => {
		expect(parseCliArgs(["fix", "the tests"], "/home")).toEqual({
			prompt: "fix the tests",
			yes: false,
			cwd: "/home",
			help: false,
			version: false,
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
			cwd: "/home/other",
			help: false,
			version: false,
		});
		expect(parseCliArgs(["-y", "x"], "/home").yes).toBe(true);
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
		[["   "], /The prompt is empty/],
	])("rejects %j", (argv, message) => {
		expect(() => parseCliArgs(argv, "/h")).toThrow(UsageError);
		expect(() => parseCliArgs(argv, "/h")).toThrow(message);
	});
});
