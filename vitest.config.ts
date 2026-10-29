import { defineConfig } from "vitest/config";

export default defineConfig({
	oxc: { jsx: { runtime: "automatic" } },
	test: {
		include: ["atelier-*/test/**/*.test.{ts,tsx}"],
		// The suite never sweeps the real temporary folder; scratch.test.ts turns the sweep on over its own.
		env: { ATELIER_SCRATCH_SWEEP: "off" },
		// An empty home per worker, and a guard that fails a test which runs the real Claude Code or Keychain.
		setupFiles: ["atelier-core/test/support/setup.ts"],
		// Inside a sandbox the Seatbelt and PTY tests skip: the run ends with a warning that says so.
		globalSetup: ["atelier-core/test/support/nested-sandbox.ts"],
	},
});
