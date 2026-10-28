import { afterEach } from "vitest";
import { guardCredentials, isolatedHome, REAL_HOME } from "./credential-guard.ts";

// Every test worker runs with an empty home of its own, whatever HOME the suite was started with.
if (process.env.HOME === undefined || process.env.HOME === REAL_HOME) process.env.HOME = isolatedHome();

const violations: string[] = [];
guardCredentials((command) => violations.push(command));

afterEach(() => {
	const ran = violations.splice(0);
	if (ran.length > 0) throw new Error(`test isolation: the test tried to run ${ran.join(", ")}; inject a fake`);
});
