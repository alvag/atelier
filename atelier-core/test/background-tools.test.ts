import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBackgroundTools } from "../src/tools/background.ts";
import { type EndedJob, Jobs, MAX_RUNNING_JOBS } from "../src/tools/jobs.ts";
import { Sandbox, type SandboxManagerLike } from "../src/tools/sandbox.ts";
import type { ToolContext, ToolDefinition } from "../src/tools/types.ts";

const until = async (condition: () => boolean) => {
	for (let i = 0; i < 400 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	expect(condition()).toBe(true);
};

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

let dirs: string[] = [];
let open: Jobs[] = [];

afterEach(async () => {
	await Promise.all(open.map((jobs) => jobs.stopAll()));
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs = [];
	open = [];
});

function harness(options: { outside?: boolean; available?: boolean } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "atelier-bg-"));
	dirs.push(cwd);
	const ended: EndedJob[] = [];
	const jobs = new Jobs({ scratchDir: cwd, onEnded: (end) => ended.push(end) });
	open.push(jobs);
	const { sandbox, wrapped } = sandboxed(options);
	const [background, list, stop] = createBackgroundTools({ sandbox }) as [
		ToolDefinition,
		ToolDefinition,
		ToolDefinition,
	];
	const context: ToolContext = { cwd, scratchDir: cwd, jobs };
	return { cwd, jobs, ended, wrapped, background, list, stop, context };
}

describe("bash_background", () => {
	it("starts the command in the sandbox, answers at once, and notices its end", async () => {
		const h = harness();
		const started = await h.background.execute({ command: "echo done", label: "say done" }, h.context);
		expect(started).toEqual({
			ok: true,
			output: `Started background job 1 ("say done"). Output: ${join(h.cwd, "job-1.log")}\nYou get a notice when it ends; job_list shows it and job_stop stops it.`,
			summary: "say done (job 1 started)",
			truncated: false,
			fullOutputPath: join(h.cwd, "job-1.log"),
		});
		expect(h.wrapped).toEqual(["echo done"]);
		await until(() => h.ended.length === 1);
		expect(h.ended[0]?.notice).toContain("<job_output>\ndone\n</job_output>");
	});

	it("goes through bash's gate: the guard, the user's rules, unsandboxed and its reason, the question", async () => {
		const h = harness({ available: false });
		const gate = (input: object, context: Partial<ToolContext> = {}) =>
			h.background.gate?.(input, { ...h.context, ...context });
		expect((await gate({ command: "git reset --hard" }))?.refusal?.output).toBe(
			"Refused: git reset --hard — git reset --hard",
		);
		expect((await gate({ command: "rm -r build" }))?.approval?.confirm).toBe("recursive removal");
		await expect(gate({ command: "npm install", unsandboxed: true })).rejects.toThrow(
			"reason is required with unsandboxed",
		);
		expect(await gate({ command: "open x.png" }, { bashRules: ["open"] })).toEqual({});
		// Without the sandbox, every command asks, as bash's do.
		expect((await gate({ command: "sleep 60" }))?.approval?.command).toBe("sleep 60");
		expect(h.background.approvalCommand({ command: "sleep 60" })).toBe("sleep 60");
	});

	it("refuses what the guard refuses even when called directly", async () => {
		const h = harness();
		const refused = await h.background.execute({ command: "git reset --hard" }, h.context);
		expect(refused).toMatchObject({ ok: false, output: "Refused: git reset --hard — git reset --hard" });
		expect(h.jobs.list()).toEqual([]);
	});

	it("runs a covered command outside the sandbox and says so", async () => {
		const h = harness();
		const started = await h.background.execute({ command: "echo -n covered" }, { ...h.context, bashRules: ["echo"] });
		expect(started.output).toContain(
			"[ran outside the sandbox: the user allows echo there without asking; do not set unsandboxed for it]",
		);
		expect(h.wrapped).toEqual([]);
	});

	it("says so past the cap of running jobs", async () => {
		const h = harness();
		for (let i = 0; i < MAX_RUNNING_JOBS; i++) await h.background.execute({ command: "sleep 300" }, h.context);
		const refused = await h.background.execute({ command: "sleep 300" }, h.context);
		expect(refused).toMatchObject({
			ok: false,
			output: "Refused: 16 background jobs are running; stop one with job_stop or wait for one to end.",
		});
	});

	it("is not available without the session's jobs", async () => {
		const h = harness();
		const refused = await h.background.execute({ command: "sleep 1" }, { cwd: h.cwd });
		expect(refused).toMatchObject({ ok: false, output: "Background jobs are not available here." });
	});
});

describe("job_list and job_stop", () => {
	it("list the jobs and stop one without a notice", async () => {
		const h = harness();
		expect(await h.list.execute({}, h.context)).toMatchObject({ ok: true, output: "No background jobs." });
		await h.background.execute({ command: "sleep 300", label: "ci wait" }, h.context);
		const listed = await h.list.execute({}, h.context);
		expect(listed.output).toMatch(/^1 {2}running {2}\d+s {2}ci wait {2}.*job-1\.log$/);
		expect(listed.summary).toBe("1 job");
		const stopped = await h.stop.execute({ id: "1" }, h.context);
		expect(stopped).toMatchObject({ ok: true, summary: "job 1 stopped" });
		expect(stopped.output).toMatch(/^Stopped job 1 \("ci wait"\) after \d+s; no notice follows\.$/);
		expect(h.ended).toEqual([{ job: expect.objectContaining({ status: "stopped" }) }]);
		expect(await h.stop.execute({ id: "7" }, h.context)).toMatchObject({ ok: false, output: "No job 7." });
	});
});
