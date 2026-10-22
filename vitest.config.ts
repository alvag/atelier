import { defineConfig } from "vitest/config";

export default defineConfig({
	oxc: { jsx: { runtime: "automatic" } },
	test: {
		include: ["atelier-*/test/**/*.test.{ts,tsx}"],
	},
});
