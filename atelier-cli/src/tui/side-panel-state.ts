import { type AtelierEvent, type JsonValue, type McpServerStatus, type Usage, ZERO_USAGE } from "@atelier/core";
import { type FeatureState, featureAfter } from "./feature-panel.ts";
import { callLabel } from "./tool-card.ts";

/** Finished jobs and agents the panel keeps, the latest ones; running ones are always kept. */
export const MAX_FINISHED_ROWS = 50;

/** A background job (`bash_background`): `startedAt` is when the TUI heard it start. */
export interface PanelJob {
	id: string;
	label: string;
	status: "running" | "exited" | "failed" | "stopped";
	exitCode?: number;
	signal?: string;
	startedAt: number;
	durationMs?: number;
	/** When it ended, to list the finished ones newest first. */
	endedAt?: number;
}

/** A subagent: a `task` call of the main agent (`key` is its call id) or a background task (`key` is its task id). */
export interface PanelAgent {
	key: string;
	agent: string;
	label: string;
	background: boolean;
	status: "running" | "finished" | "failed" | "stopped";
	model?: string;
	/** The call it runs now, `edit footer.ts`; only a foreground subagent's calls reach the client. */
	tool?: { callId: string; label: string };
	usage?: Usage;
	costUsd?: number;
	error?: string;
	startedAt: number;
	durationMs?: number;
	endedAt?: number;
}

/** What the Status section sums up, from the session's events. */
export interface PanelStatus {
	/** Whether this process has begun its first main-agent turn, independent of its integrations. */
	firstTurnStarted: boolean;
	/** The main agent's turns. */
	turns: number;
	/** Every turn's tokens, the subagents' included. */
	tokens: Usage;
	/** The tokens of the main agent's own requests (`phases.main`), for its cache rate. */
	main: Usage;
	compactions: number;
	lastCompaction?: { before: number; after?: number };
	memory?: { available: boolean; project?: string; reason?: string; savedId?: number };
	mcp?: { servers: McpServerStatus[]; problems: string[] };
	review?: { available: boolean; reason?: string };
	reviews: number;
	findings: number;
	instructions?: string[];
	/** Paths omitted by the core's 32 KB instructions cap; the event gives no per-file reason. */
	droppedInstructions?: string[];
	skills?: string[];
}

export interface SidePanelState {
	jobs: PanelJob[];
	agents: PanelAgent[];
	/** The jobs (`job:<id>`) and tasks (`task:<id>`) whose notice the agent has not read, oldest first. */
	unread: string[];
	feature?: FeatureState;
	status: PanelStatus;
}

export function emptySidePanel(): SidePanelState {
	return {
		jobs: [],
		agents: [],
		unread: [],
		status: {
			firstTurnStarted: false,
			turns: 0,
			tokens: ZERO_USAGE,
			main: ZERO_USAGE,
			compactions: 0,
			reviews: 0,
			findings: 0,
		},
	};
}

/**
 * A resumed session's panel: what its saved events add up to (turns, tokens, compactions, reviews). Its jobs and agents
 * ended with the process that ran them, what it runs with comes again in its next turn, and its feature waits for the
 * session's own events, as the panel over the editor does.
 */
export function sidePanelResumed(saved: readonly AtelierEvent[]): SidePanelState {
	const { status } = saved.reduce((state, event) => sidePanelAfter(state, event, 0), emptySidePanel());
	const { turns, tokens, main, compactions, lastCompaction, reviews, findings } = status;
	const counted = { firstTurnStarted: false, turns, tokens, main, compactions, reviews, findings };
	return { ...emptySidePanel(), status: lastCompaction === undefined ? counted : { ...counted, lastCompaction } };
}

const addUsage = (a: Usage, b: Usage): Usage => ({
	input: a.input + b.input,
	output: a.output + b.output,
	cacheRead: a.cacheRead + b.cacheRead,
	cacheWrite: a.cacheWrite + b.cacheWrite,
});

const field = (input: JsonValue, name: string): JsonValue | undefined =>
	typeof input === "object" && input !== null && !Array.isArray(input) ? input[name] : undefined;

/** A `task` call's label, as the core names a background task: its `label`, else the prompt's first line. */
function taskLabel(input: JsonValue): string {
	const label = field(input, "label");
	if (typeof label === "string" && label.trim() !== "") return label;
	const prompt = field(input, "prompt");
	return typeof prompt === "string" ? (prompt.split("\n").find((line) => line.trim() !== "") ?? "") : "";
}

/** The review's and the verifier's turns are already parts of the turn that ran them. */
const insideParentTurn = (agent: string | undefined) =>
	agent !== undefined && (agent.startsWith("review:") || agent.startsWith("verify:"));

/** Keeps every running row and the latest finished ones. */
function capped<T extends { status: string; endedAt?: number }>(rows: T[]): T[] {
	const finished = rows.filter((row) => row.status !== "running");
	if (finished.length <= MAX_FINISHED_ROWS) return rows;
	const oldest = new Set(
		[...finished].sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0)).slice(0, finished.length - MAX_FINISHED_ROWS),
	);
	return rows.filter((row) => !oldest.has(row));
}

/** The unread notices once the session says how many wait: the agent reads them oldest first. */
const unreadAfter = (unread: string[], waiting: number) => (waiting <= 0 ? [] : unread.slice(-waiting));

const updated = <T extends { key?: string; id?: string }>(rows: T[], key: string, change: (row: T) => T) =>
	rows.map((row) => ((row.key ?? row.id) === key ? change(row) : row));

/** The panel after one of the session's events; `now` stamps what starts and ends. */
export function sidePanelAfter(state: SidePanelState, event: AtelierEvent, now: number): SidePanelState {
	if (event.parentCallId !== undefined) return childAfter(state, event, event.parentCallId);
	switch (event.type) {
		case "feature_changed": {
			const feature = featureAfter(state.feature, event);
			return feature === undefined ? state : { ...state, feature };
		}
		case "job_started":
			return {
				...state,
				jobs: [...state.jobs, { id: event.jobId, label: event.label, status: "running", startedAt: now }],
			};
		case "job_finished": {
			const ended = (job: PanelJob): PanelJob => ({
				...job,
				status: event.status,
				...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
				...(event.signal === undefined ? {} : { signal: event.signal }),
				durationMs: event.durationMs,
				endedAt: now,
			});
			const known = state.jobs.some((job) => job.id === event.jobId);
			const jobs = known
				? updated(state.jobs, event.jobId, ended)
				: [...state.jobs, ended({ id: event.jobId, label: event.label, status: "running", startedAt: now })];
			const unread = event.notified ? [...state.unread, `job:${event.jobId}`] : state.unread;
			return { ...state, jobs: capped(jobs), unread: unreadAfter(unread, event.waiting) };
		}
		case "task_started":
			return {
				...state,
				agents: [
					...state.agents,
					{
						key: event.taskId,
						agent: event.agent,
						label: event.label,
						background: true,
						status: "running",
						...(event.model === undefined ? {} : { model: event.model }),
						startedAt: now,
					},
				],
			};
		case "task_finished": {
			const ended = (agent: PanelAgent): PanelAgent => ({
				...agent,
				status: event.status,
				...(event.error === undefined ? {} : { error: event.error }),
				...(event.usage === undefined ? {} : { usage: event.usage }),
				...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
				durationMs: event.durationMs,
				endedAt: now,
			});
			const known = state.agents.some((agent) => agent.key === event.taskId);
			const agents = known
				? updated(state.agents, event.taskId, ended)
				: [
						...state.agents,
						ended({
							key: event.taskId,
							agent: event.agent,
							label: event.label,
							background: true,
							status: "running",
							startedAt: now,
						}),
					];
			const unread = event.notified ? [...state.unread, `task:${event.taskId}`] : state.unread;
			const tokens = event.usage === undefined ? state.status.tokens : addUsage(state.status.tokens, event.usage);
			return {
				...state,
				agents: capped(agents),
				unread: unreadAfter(unread, event.waiting),
				status: { ...state.status, tokens },
			};
		}
		case "jobs_status":
			return { ...state, unread: unreadAfter(state.unread, event.waiting) };
		case "tool_call_started": {
			if (event.tool !== "task" || field(event.input, "background") === true) return state;
			const agent = field(event.input, "agent");
			const row: PanelAgent = {
				key: event.callId,
				agent: typeof agent === "string" ? agent : "subagent",
				label: taskLabel(event.input),
				background: false,
				status: "running",
				startedAt: now,
			};
			return { ...state, agents: [...state.agents, row] };
		}
		case "tool_call_finished":
			return {
				...state,
				agents: capped(
					updated(state.agents, event.callId, (agent) =>
						agent.background || agent.status !== "running"
							? agent
							: foregroundEnded(agent, now, event.ok ? undefined : event.summary),
					),
				),
			};
		case "turn_finished": {
			const main = event.phases?.main?.usage;
			// A `task` call the turn left running ends with it: nothing reports it any more.
			const left = event.stopReason === "interrupted" ? "interrupted" : "the turn ended";
			return {
				...state,
				agents: state.agents.map((agent) =>
					agent.background || agent.status !== "running" ? agent : foregroundEnded(agent, now, left),
				),
				status: {
					...state.status,
					firstTurnStarted: true,
					turns: state.status.turns + 1,
					tokens: addUsage(state.status.tokens, event.usage),
					main: main === undefined ? state.status.main : addUsage(state.status.main, main),
				},
			};
		}
		default:
			return { ...state, status: statusAfter(state.status, event) };
	}
}

function foregroundEnded(agent: PanelAgent, now: number, error: string | undefined): PanelAgent {
	const { tool: _tool, ...rest } = agent;
	return {
		...rest,
		status: error === undefined ? "finished" : "failed",
		...(error === undefined ? {} : { error }),
		durationMs: now - agent.startedAt,
		endedAt: now,
	};
}

/** A subagent's event: its model, the call it runs and what its turns used; its tokens count for the session too. */
function childAfter(state: SidePanelState, event: AtelierEvent, parentCallId: string): SidePanelState {
	if (event.type === "turn_finished" && insideParentTurn(event.agent)) return state;
	const tokens = event.type === "turn_finished" ? addUsage(state.status.tokens, event.usage) : state.status.tokens;
	const agents = updated(state.agents, parentCallId, (agent): PanelAgent => {
		if (agent.background || agent.status !== "running") return agent;
		switch (event.type) {
			// A subagent's own subagents speak through it: the first model is its own.
			case "session_started":
				return agent.model === undefined ? { ...agent, model: event.model } : agent;
			case "tool_call_started":
				return { ...agent, tool: { callId: event.callId, label: callLabel(event.tool, event.input) } };
			case "tool_call_finished": {
				if (agent.tool?.callId !== event.callId) return agent;
				const { tool: _tool, ...rest } = agent;
				return rest;
			}
			case "turn_finished":
				return {
					...agent,
					usage: addUsage(agent.usage ?? ZERO_USAGE, event.usage),
					...(event.costUsd === undefined ? {} : { costUsd: (agent.costUsd ?? 0) + event.costUsd }),
				};
			default:
				return agent;
		}
	});
	return { ...state, agents, status: { ...state.status, tokens } };
}

/** The Status section after one of the main agent's other events. */
function statusAfter(status: PanelStatus, event: AtelierEvent): PanelStatus {
	switch (event.type) {
		case "compaction_finished":
			if (!event.ok) return status;
			return {
				...status,
				compactions: status.compactions + 1,
				lastCompaction: {
					before: event.tokensBefore,
					...(event.tokensAfter === undefined ? {} : { after: event.tokensAfter }),
				},
			};
		case "session_started":
			return { ...status, firstTurnStarted: true };
		case "memory_status":
			return {
				...status,
				firstTurnStarted: true,
				memory: {
					available: event.available,
					...(event.project === undefined ? {} : { project: event.project }),
					...(event.reason === undefined ? {} : { reason: event.reason }),
					...(status.memory?.savedId === undefined ? {} : { savedId: status.memory.savedId }),
				},
			};
		case "memory_summary_saved":
			return { ...status, memory: { available: true, ...status.memory, savedId: event.id } };
		case "mcp_status":
			return {
				...status,
				mcp: {
					servers: event.servers,
					problems: event.problems,
				},
			};
		case "review_status":
			return {
				...status,
				review: { available: event.available, ...(event.reason === undefined ? {} : { reason: event.reason }) },
			};
		case "review_finished": {
			const { review: _review, ...rest } = status;
			return { ...rest, reviews: status.reviews + 1, findings: status.findings + event.findings.length };
		}
		case "project_instructions":
			return { ...status, firstTurnStarted: true, instructions: event.files, droppedInstructions: event.dropped };
		case "skills_loaded":
			return { ...status, firstTurnStarted: true, skills: event.skills.map((skill) => skill.name) };
		default:
			return status;
	}
}
