/** The turns that the notices of a measured session's background work wake, run until none runs or waits. */
import type { AtelierEvent } from "../src/index.ts";

/** What of a session the loop needs: its background work, and the turn its waiting notices start. */
export interface WakingSession {
	readonly jobs: { running: number; waiting: number };
	nextQueued(): AsyncGenerator<AtelierEvent> | undefined;
}

export interface WokenTurnsOptions {
	/** How long the background work may run in all. */
	limitMs: number;
	/** Waits up to `ms` for a notice to wake the session. */
	wait: (ms: number) => Promise<void>;
}

/**
 * Runs each turn the notices wake, giving its events to `take`, until no background work runs or waits. Says why it
 * stopped before that: notices that no turn will take, as a failed or interrupted turn leaves them for a prompt of the
 * user's, while nothing more runs; or work still running at the limit. Undefined when all of it ended.
 */
export async function runWokenTurns(
	session: WakingSession,
	take: (event: AtelierEvent) => void,
	{ limitMs, wait }: WokenTurnsOptions,
): Promise<string | undefined> {
	const deadline = Date.now() + limitMs;
	while (session.jobs.running > 0 || session.jobs.waiting > 0) {
		const next = session.nextQueued();
		if (next !== undefined) {
			for await (const event of next) take(event);
			continue;
		}
		const { running, waiting } = session.jobs;
		if (running === 0)
			return `${waiting} background notice${waiting === 1 ? "" : "s"} waited that no turn took (a turn failed or was interrupted), with no background work running`;
		const left = deadline - Date.now();
		if (left <= 0) return `background work still ran after ${limitMs / 60_000} minutes`;
		await wait(Math.min(left, 1000));
	}
	return undefined;
}
