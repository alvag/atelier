import { z } from "zod";
import {
	type BashOptions,
	type CommandSettings,
	coveredNote,
	gateCommand,
	guardRefusal,
	prepareCommand,
	preparedBlocks,
} from "./bash.ts";
import { JobRefusedError, jobListText, jobStartedText, jobStopText, MAX_RUNNING_JOBS } from "./jobs.ts";
import { sandbox as sharedSandbox } from "./sandbox.ts";
import { defineTool, type ToolDefinition, type ToolOutcome } from "./types.ts";

export const BASH_BACKGROUND_TOOL = "bash_background";
export const JOB_LIST_TOOL = "job_list";
export const JOB_STOP_TOOL = "job_stop";

const NOT_AVAILABLE = "Background jobs are not available here.";

const failed = (output: string, summary = output): ToolOutcome => ({ ok: false, output, summary, truncated: false });

/**
 * `bash_background`, `job_list` and `job_stop`: commands that run while the agent goes on, through the same gate and
 * sandbox as `bash`, in the session's jobs (`ToolContext.jobs`). Only the main agent of a session has them.
 */
export function createBackgroundTools({
	env = {},
	sandbox = sharedSandbox,
}: Pick<BashOptions, "env" | "sandbox"> = {}): ToolDefinition[] {
	const settings: CommandSettings = { withoutApproval: false, env, policy: "agent", sandbox };
	const background = defineTool({
		name: BASH_BACKGROUND_TOOL,
		description: `Start a shell command in the background, in the working directory, and return at once with its job id. When it ends you get one notice with its exit code, how long it ran and the end of its output; meanwhile keep working. For long waits: a CI run, a build, another agent reaching idle. Same sandbox, rules and questions as bash; the full output goes to a file. At most ${MAX_RUNNING_JOBS} run at once; job_list shows them and job_stop stops one.`,
		inputShape: {
			command: z.string().min(1).describe("Command to run"),
			label: z.string().optional().describe("A short name for the job; its first line without it"),
			unsandboxed: z
				.boolean()
				.optional()
				.describe(
					"Run this command outside the sandbox, only when it cannot work inside it. The user is asked unless the session runs in yolo mode; give the reason. A command the user's rules allow runs outside the sandbox without it.",
				),
			reason: z.string().optional().describe("Required with unsandboxed: why this command must leave the sandbox"),
		},
		approvalCommand: ({ command }) => command,
		gate: (input, context) => gateCommand(input, context, settings),
		async execute({ command, label, unsandboxed }, context) {
			// The session asks the gate first; this keeps a direct call from running what the guard refuses.
			const refused = guardRefusal(command, context.cwd);
			if (refused !== undefined) return refused;
			const { jobs } = context;
			if (jobs === undefined) return failed(NOT_AVAILABLE);
			// Not the turn's signal: the job outlives the turn.
			const preparing = await prepareCommand({ command, unsandboxed }, context, settings);
			if ("refused" in preparing) return preparing.refused;
			const { prepared } = preparing;
			try {
				const job = jobs.start({
					command,
					...(label === undefined ? {} : { label }),
					run: { file: prepared.file, args: prepared.args, cwd: context.cwd, env: prepared.env },
					blocked: (output) => preparedBlocks(prepared, settings, output, context.cwd),
					...(prepared.sandboxed ? { cleanup: () => sandbox.cleanup() } : {}),
				});
				return {
					ok: true,
					output: `${jobStartedText(job)}${prepared.covered ? `\n${coveredNote(command)}` : ""}`,
					summary: `${job.label} (job ${job.id} started)`,
					truncated: false,
					fullOutputPath: job.outputPath,
				};
			} catch (error) {
				if (prepared.sandboxed) sandbox.cleanup();
				if (error instanceof JobRefusedError) return failed(error.message);
				return failed(`The job could not start: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});
	const list = defineTool({
		name: JOB_LIST_TOOL,
		description:
			"List the background jobs of this session, running and recently finished: id, status, elapsed time, label and output file.",
		inputShape: {},
		async execute(_input, { jobs }) {
			if (jobs === undefined) return failed(NOT_AVAILABLE);
			const all = jobs.list();
			return {
				ok: true,
				output: jobListText(all),
				summary: `${all.length} job${all.length === 1 ? "" : "s"}`,
				truncated: false,
			};
		},
	});
	const stop = defineTool({
		name: JOB_STOP_TOOL,
		description:
			"Stop a background job: its whole process tree is killed, SIGTERM then SIGKILL. A stopped job sends no notice.",
		inputShape: { id: z.string().min(1).describe("The job id bash_background answered") },
		async execute({ id }, { jobs }) {
			if (jobs === undefined) return failed(NOT_AVAILABLE);
			const result = await jobs.stop(id);
			const output = jobStopText(result);
			if (result.outcome === "unknown") return failed(output);
			return {
				ok: true,
				output,
				summary: result.outcome === "stopped" ? `job ${id} stopped` : `job ${id} had ended`,
				truncated: false,
			};
		},
	});
	return [background, list, stop];
}
