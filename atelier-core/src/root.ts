/** The exact value of `ATELIER_ALLOW_ROOT` that lets Atelier run as root: nothing looser counts as consent. */
export const ALLOW_ROOT_VALUE = "I accept the risk";

export type RootCheck = { allowed: true; warning?: string } | { allowed: false; message: string };

/**
 * Atelier does not start as root (uid 0), where a mistaken command can damage the
 * whole system, unless `ATELIER_ALLOW_ROOT` is exactly "I accept the risk"; then it
 * starts and gives the warning, which the caller shows on every start.
 */
export function checkRoot(uid: number | undefined, env: Record<string, string | undefined>): RootCheck {
	if (uid !== 0) return { allowed: true };
	const given = env.ATELIER_ALLOW_ROOT;
	if (given === ALLOW_ROOT_VALUE)
		return {
			allowed: true,
			warning: `warning: running as root (uid 0) because ATELIER_ALLOW_ROOT is set: every command has full control of this system.`,
		};
	const seen =
		given === undefined ? "" : ` ATELIER_ALLOW_ROOT is set to ${JSON.stringify(given)}, which is not that exact text.`;
	return {
		allowed: false,
		message: `Atelier will not run as root (uid 0): a mistaken command could damage the whole system. To run as root anyway, set ATELIER_ALLOW_ROOT="${ALLOW_ROOT_VALUE}" (exactly that text).${seen}`,
	};
}
