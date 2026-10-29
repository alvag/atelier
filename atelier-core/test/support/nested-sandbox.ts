import { isInsideSandbox } from "../../src/tools/sandbox.ts";

/** Said at the end of a run whose Seatbelt tests skipped: a green run inside a sandbox does not cover them. */
export const NESTED_SANDBOX_WARNING = [
	"",
	"WARNING: this test run was inside a sandbox, and macOS cannot nest one: the Seatbelt tests did not run,",
	"so a green result does not cover them. Run them outside the sandbox with a new, empty HOME and TMPDIR:",
	"  H=$(mktemp -d); mkdir $H/tmp; HOME=$H TMPDIR=$H/tmp NO_UPDATE_NOTIFIER=1 node_modules/.bin/vitest run <files>",
	"",
	"",
].join("\n");

/** Probes once when the run starts; the teardown it returns says the warning last, where a cut output still shows it. */
export function warnIfNested(inside: () => boolean, write: (text: string) => void): () => void {
	const nested = inside();
	return () => {
		if (nested) write(NESTED_SANDBOX_WARNING);
	};
}

/** Vitest's global setup: runs once per run, in the main process, under the same sandbox as the workers. */
export default function setup(): () => void {
	return warnIfNested(isInsideSandbox, (text) => process.stderr.write(text));
}
