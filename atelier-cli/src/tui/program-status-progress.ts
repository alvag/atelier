import type { FeatureTask } from "@atelier/core";

/** Whole-percent feature progress: done over non-dropped tasks, or undefined when none count. */
export function featureTaskProgress(tasks: readonly FeatureTask[] | undefined): number | undefined {
	const counted = (tasks ?? []).filter((task) => task.status !== "dropped");
	if (counted.length === 0) return undefined;
	const done = counted.filter((task) => task.status === "done").length;
	return Math.floor((done * 100) / counted.length);
}
