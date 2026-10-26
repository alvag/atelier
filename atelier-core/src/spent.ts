import {
	type AtelierEventBody,
	type Effort,
	type PhaseAgent,
	type PhaseSpent,
	TURN_PHASES,
	type TurnPhase,
	type TurnPhases,
	type Usage,
} from "./events.ts";

/** Two costs added up; a count stays absent only when neither side knows it. */
export function addPhaseSpent(a: PhaseSpent, b: PhaseSpent): PhaseSpent {
	const requests = addKnown(a.requests, b.requests);
	const costUsd = addKnown(a.costUsd, b.costUsd);
	const agents = addAgents(a.agents, b.agents);
	return {
		usage: addUsage(a.usage, b.usage),
		...(requests === undefined ? {} : { requests }),
		...(costUsd === undefined ? {} : { costUsd }),
		...(agents === undefined ? {} : { agents }),
	};
}

/** Two breakdowns merged part by part, in the order the parts run. */
export function addPhases(a: TurnPhases | undefined, b: TurnPhases | undefined): TurnPhases | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	const phases: TurnPhases = {};
	for (const phase of TURN_PHASES) {
		const left = a[phase];
		const right = b[phase];
		const sum = left && right ? addPhaseSpent(left, right) : (left ?? right);
		if (sum) phases[phase] = sum;
	}
	return phases;
}

/** A breakdown with a single part. */
export function onePhase(phase: TurnPhase, spent: PhaseSpent): TurnPhases {
	const { usage, requests, costUsd, agents } = spent;
	return {
		[phase]: {
			usage: { ...usage },
			...(requests === undefined ? {} : { requests }),
			...(costUsd === undefined ? {} : { costUsd }),
			...(agents === undefined ? {} : { agents: agents.map((agent) => ({ ...agent })) }),
		},
	};
}

/** The agent a `session_started` describes, under its profile role. */
export function phaseAgent(role: string, started: Extract<AtelierEventBody, { type: "session_started" }>): PhaseAgent {
	return {
		role,
		backend: started.backend,
		model: started.model,
		...(started.effort === undefined ? {} : { effort: started.effort }),
	};
}

/** The agent with the effort its backend applied, only when no level was asked and the backend says one. */
export function withEffectiveEffort(
	agent: PhaseAgent | undefined,
	effective: Effort | undefined,
): PhaseAgent | undefined {
	if (agent === undefined || effective === undefined || agent.effort !== undefined) return agent;
	return { ...agent, effectiveEffort: effective };
}

/** Both lists, each agent once, in the order they first ran. */
function addAgents(a: PhaseAgent[] | undefined, b: PhaseAgent[] | undefined): PhaseAgent[] | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	const agents = [...a];
	for (const agent of b) if (!agents.some((known) => sameAgent(known, agent))) agents.push(agent);
	return agents;
}

function sameAgent(a: PhaseAgent, b: PhaseAgent): boolean {
	return (
		a.role === b.role &&
		a.backend === b.backend &&
		a.model === b.model &&
		a.effort === b.effort &&
		a.effectiveEffort === b.effectiveEffort
	);
}

function addUsage(a: Usage, b: Usage): Usage {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
	};
}

function addKnown(a: number | undefined, b: number | undefined): number | undefined {
	return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}
