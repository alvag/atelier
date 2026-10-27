import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createBashTool } from "../src/index.ts";
import { Sandbox, type SandboxManagerLike } from "../src/tools/sandbox.ts";

/** The system temporary directory: commands need a working directory they can read. */
const cwd = tmpdir();

/** A sandbox that is there and wraps nothing, counting the commands it wrapped; `outside` says whether the profile for covered commands runs. */
function sandboxed({ outside = true, available = true } = {}) {
	const wrapped: string[] = [];
	const manager: SandboxManagerLike = {
		isSupportedPlatform: () => true,
		checkDependencies: () => ({ errors: available ? [] : ["missing"], warnings: [] }),
		initialize: async () => {},
		wrapWithSandbox: async (command) => {
			wrapped.push(command);
			return command;
		},
		cleanupAfterCommand: () => {},
		reset: async () => {},
	};
	return { sandbox: new Sandbox({ platform: "darwin", manager, outside: () => outside }), wrapped };
}

const gateOf = async (
	input: { command: string; unsandboxed?: boolean; reason?: string },
	bashRules: string[],
	options: { outside?: boolean; available?: boolean; verifier?: boolean } = {},
) => {
	const { sandbox } = sandboxed(options);
	const tool = createBashTool({ sandbox, ...(options.verifier ? { policy: "verifier" as const } : {}) });
	return tool.gate?.(input, { cwd, bashRules });
};

describe("bash and the user's rules", () => {
	it("asks nothing about a covered command, also without a sandbox or when the agent asks to leave it", async () => {
		expect(await gateOf({ command: "open x.png" }, ["open"], { available: false })).toEqual({});
		expect(await gateOf({ command: "open x.png", unsandboxed: true, reason: "GUI" }, ["open"])).toEqual({});
		expect(await gateOf({ command: "mkdir -p x && open x" }, ["open", "mkdir"], { available: false })).toEqual({});
	});

	it("asks about a line one of whose commands is not covered", async () => {
		const gate = await gateOf({ command: "mkdir -p x && open x", unsandboxed: true, reason: "GUI" }, ["open"]);
		expect(gate?.approval?.command).toBe("mkdir -p x && open x");
	});

	it("asks about a launcher even when its program's rule is allowed", async () => {
		const gate = await gateOf({ command: "pnpm dlx evil-pkg", unsandboxed: true, reason: "r" }, ["pnpm"]);
		expect(gate?.approval).toMatchObject({
			command: "pnpm dlx evil-pkg",
			remember: { rules: ["pnpm dlx"], always: false },
		});
	});

	it("never covers what the guard asks about or refuses", async () => {
		expect((await gateOf({ command: "rm -r build" }, ["rm"]))?.approval?.confirm).toBe("recursive removal");
		expect((await gateOf({ command: "git push" }, ["git"]))?.approval?.confirm).toBe("git push");
		expect((await gateOf({ command: "git reset --hard" }, ["git"]))?.refusal).toBeDefined();
	});

	it("does not cover when the profile for covered commands cannot run, nor for the verifier", async () => {
		const gate = await gateOf({ command: "open x" }, ["open"], { available: false, outside: false });
		expect(gate?.approval?.command).toBe("open x");
		// Nothing to remember there either: only Allow and Deny.
		expect(gate?.approval?.remember).toBeUndefined();
		const leaving = await gateOf({ command: "open x", unsandboxed: true, reason: "GUI" }, [], { outside: false });
		expect(leaving?.approval).toMatchObject({ command: "open x" });
		expect(leaving?.approval?.remember).toBeUndefined();
		const verifier = await gateOf({ command: "open x", unsandboxed: true, reason: "GUI" }, ["open"], {
			verifier: true,
		});
		expect(verifier?.refusal).toBeDefined();
	});

	it("runs a covered command outside the sandbox, even when the agent did not ask to leave it", async () => {
		const { sandbox, wrapped } = sandboxed();
		const tool = createBashTool({ sandbox });
		const covered = await tool.execute({ command: "echo -n covered" }, { cwd, bashRules: ["echo"] });
		expect(covered.ok).toBe(true);
		expect(covered.output).toContain("covered");
		expect(covered.output).toContain(
			"[ran outside the sandbox: the user allows echo there without asking; do not set unsandboxed for it]",
		);
		expect(wrapped).toEqual([]);
		await tool.execute({ command: "echo inside" }, { cwd, bashRules: ["ls"] });
		expect(wrapped).toEqual(["echo inside"]);
	});
});
