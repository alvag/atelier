import { type PhaseSpent, TURN_PHASES, type TurnPhase, type TurnPhases, type Usage } from "./events.ts";

/** Two costs added up; a count stays absent only when neither side knows it. */
export function addPhaseSpent(a: PhaseSpent, b: PhaseSpent): PhaseSpent {
	const requests = addKnown(a.requests, b.requests);
	const costUsd = addKnown(a.costUsd, b.costUsd);
	return {
		usage: addUsage(a.usage, b.usage),
		...(requests === undefined ? {} : { requests }),
		...(costUsd === undefined ? {} : { costUsd }),
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
	const { usage, requests, costUsd } = spent;
	return {
		[phase]: {
			usage: { ...usage },
			...(requests === undefined ? {} : { requests }),
			...(costUsd === undefined ? {} : { costUsd }),
		},
	};
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
