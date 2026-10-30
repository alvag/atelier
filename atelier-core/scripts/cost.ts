/**
 * Costs in the measurement scripts. A backend may not report a cost; that is
 * unknown, never $0, and any total that includes it is unknown too.
 */

/** Caps each main turn: the main agent has no limit of its own, and these scripts run unattended on paid tokens. */
export const MEASURE_MAX_REQUESTS_PER_TURN = 50;

export function addCost(total: number | undefined, more: number | undefined): number | undefined {
	return total === undefined || more === undefined ? undefined : total + more;
}

export function sumCosts(costs: readonly (number | undefined)[]): number | undefined {
	return costs.reduce<number | undefined>((total, cost) => addCost(total, cost), 0);
}

export function usd(cost: number | undefined): string {
	return cost === undefined ? "—" : `$${cost.toFixed(4)}`;
}
