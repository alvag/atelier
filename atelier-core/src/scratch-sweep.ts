/**
 * The thread the background sweep runs in: `sweepOnce` starts it unref'd, so a process that is done exits without
 * waiting for the sweep, which the next process finishes.
 */
import { workerData } from "node:worker_threads";
import { sweepStaleScratch } from "./scratch.ts";

const { tmpRoot } = workerData as { tmpRoot: string };
await sweepStaleScratch({ tmpRoot }).catch(() => {});
