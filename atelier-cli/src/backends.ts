import { appendFileSync } from "node:fs";
import { type BackendName, createBackend } from "@atelier/core";

/**
 * The backends the CLI runs in its own process: `compactAt` (ATELIER_COMPACT_AT) for the ones Atelier compacts, and
 * `recordPath` (ATELIER_RECORD_SDK) to append every raw Claude Code SDK message.
 */
export function cliBackends(options: { compactAt?: number; recordPath?: string }) {
	const { compactAt, recordPath } = options;
	return (name: BackendName) =>
		createBackend(name, {
			...(recordPath
				? { claudeCode: { onSdkMessage: (message) => appendFileSync(recordPath, `${JSON.stringify(message)}\n`) } }
				: {}),
			...(compactAt === undefined ? {} : { compactAt }),
		});
}
