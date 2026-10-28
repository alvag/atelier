import { homedir } from "node:os";
import { beforeEach } from "vitest";
import { REAL_HOME } from "./credential-guard.ts";

/** For the login tests: each fails before it starts when HOME is the user's real one. */
export function requireIsolatedHome(): void {
	beforeEach(() => {
		if (homedir() === REAL_HOME || process.env.HOME === REAL_HOME)
			throw new Error(`test isolation: HOME is the real home (${REAL_HOME}); run the login tests with an empty HOME`);
	});
}
