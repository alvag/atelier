import { defineConfig } from "vitest/config";

export default defineConfig({
	oxc: { jsx: { runtime: "automatic" } },
	test: {
		include: ["atelier-*/test/**/*.test.{ts,tsx}"],
		// The suite never sweeps the real temporary folder; scratch.test.ts turns the sweep on over its own.
		env: { ATELIER_SCRATCH_SWEEP: "off" },
		// An empty home per worker, and a guard that fails a test which runs the real Claude Code or Keychain.
		setupFiles: ["atelier-core/test/support/setup.ts"],
	},
});
