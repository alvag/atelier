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

	it("reads --mode, absent by default, and rejects an unknown one", () => {
		expect(parseCliArgs(["x"], "/h").mode).toBeUndefined();
		for (const mode of ["normal", "auto", "yolo"]) expect(parseCliArgs(["--mode", mode, "x"], "/h").mode).toBe(mode);
		expect(() => parseCliArgs(["--mode", "strict", "x"], "/h")).toThrow("--mode must be normal, auto or yolo.");
	});

	it("documents --mode, the deprecated --yes and the /mode commands in the help", () => {
		expect(USAGE).toContain("--mode <mode>");
		expect(USAGE).toContain("Deprecated alias of --mode normal");
		expect(USAGE).toContain("auto (what normal would ask");
		expect(USAGE).toContain("permission-classifier role");
		expect(USAGE).toContain("/mode [normal|auto|yolo]");
		expect(USAGE).toContain("/mode default <normal|auto|yolo>");
	});

	it("reads --backend, claude-code by default", () => {
		expect(parseCliArgs(["--backend", "anthropic-api", "x"], "/h").backend).toBe("anthropic-api");
		expect(parseCliArgs(["x"], "/h").backend).toBe("claude-code");
	});

	it("reads --continue, --resume and --no-session, absent by default, and documents them", () => {
		expect(parseCliArgs(["x"], "/h")).not.toHaveProperty("continueSession");
		expect(parseCliArgs(["x"], "/h")).not.toHaveProperty("resume");
		expect(parseCliArgs(["x"], "/h")).not.toHaveProperty("noSession");
		expect(parseCliArgs(["--continue"], "/h")).toMatchObject({ continueSession: true });
		expect(parseCliArgs(["--resume", "abc-1", "x"], "/h")).toMatchObject({ resume: "abc-1", prompt: "x" });
		expect(parseCliArgs(["--no-session", "x"], "/h")).toMatchObject({ noSession: true });
		for (const flag of ["--continue", "--resume <id>", "--no-session"]) expect(USAGE).toContain(flag);
		expect(USAGE).toContain("~/.atelier/sessions/");
	});

	it("rejects --resume without a value and combinations that make no sense", () => {
		expect(() => parseCliArgs(["--resume", " "], "/h")).toThrow(new UsageError("--resume needs a value."));
		expect(() => parseCliArgs(["--resume"], "/h")).toThrow(UsageError);
		expect(() => parseCliArgs(["--continue", "--resume", "a"], "/h")).toThrow(
			new UsageError("--continue and --resume cannot be used together."),
		);
		for (const argv of [
			["--no-session", "--continue"],
			["--no-session", "--resume", "a"],
		])
			expect(() => parseCliArgs(argv, "/h")).toThrow(/--no-session cannot be used with --continue or --resume/);
	});

	it("reads --profile, which needs a value, and documents it", () => {
		expect(parseCliArgs(["--profile", "cheap", "x"], "/h").profile).toBe("cheap");
		expect(parseCliArgs(["x"], "/h")).not.toHaveProperty("profile");
		expect(() => parseCliArgs(["--profile", " ", "x"], "/h")).toThrow(new UsageError("--profile needs a value."));
		expect(USAGE).toContain("--profile <name>");
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
