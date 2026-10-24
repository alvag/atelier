import type { SandboxPolicyName } from "./sandbox.ts";

/**
 * What the library reports about a command the sandbox stopped, as a short
 * cause for the user and the model. Only what the library saw is described:
 * a line that is not a file or a network denial (the library also logs
 * probes such as `sysctl-read`) says nothing, and no cause is invented.
 */

const FILE_WRITE = /\bfile-write[\w-]*\s+(\S.*)$/;
const FILE_READ = /\bfile-read[\w-]*\s+(\S.*)$/;
const NETWORK = /\bnetwork-outbound\s+(\S+)(?:\s+\((.*)\))?\s*$/;

/**
 * Reads the system itself makes on behalf of almost any tool (preferences,
 * logging settings); the sandbox denies them in a policy that reads nothing
 * else, and listing them would bury the cause.
 */
const SYSTEM_PROBE = /\/Library\/(Preferences|Logging|Managed Preferences)\/|\.GlobalPreferences/;

export const NO_VERIFIER_NETWORK = "no network for the verifier";

/** The cause one violation line states, or undefined for a line that is not a denial worth showing. */
export function describeViolation(line: string, policy: SandboxPolicyName): string | undefined {
	const network = NETWORK.exec(line);
	if (network) {
		const reason = policy === "verifier" ? NO_VERIFIER_NETWORK : network[2];
		return `network connect to ${network[1]}${reason === undefined ? "" : ` (${reason})`}`;
	}
	const write = FILE_WRITE.exec(line);
	if (write) return `write to ${write[1]} (not an allowed write path)`;
	const read = FILE_READ.exec(line);
	if (read && !SYSTEM_PROBE.test(read[1] ?? "")) return `read of ${read[1]} (denied by the sandbox policy)`;
	return undefined;
}

/** Network first, then writes, then reads: the order of how likely each is to be what stopped the command. */
const KIND_ORDER = ["network", "write", "read"];
const kindOf = (cause: string) => KIND_ORDER.findIndex((kind) => cause.startsWith(kind));

/** The distinct causes of the violation lines, most telling first, each kind in the order it was seen. */
export function describeViolations(lines: readonly string[], policy: SandboxPolicyName): string[] {
	const causes = lines.flatMap((line) => describeViolation(line, policy) ?? []);
	return [...new Set(causes)].sort((a, b) => kindOf(a) - kindOf(b));
}
