import { guardCredentials } from "./credential-guard.ts";

// Loaded with --import into the processes tests start: a forbidden command ends the process at once, with code 99.
guardCredentials((command) => {
	process.stderr.write(`test isolation: ${command} must not run in tests\n`);
	process.exit(99);
});
