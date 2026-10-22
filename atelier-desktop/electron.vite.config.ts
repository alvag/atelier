import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
	// @atelier/core is TypeScript source: bundle it into main instead of loading it at runtime.
	main: { build: { externalizeDeps: { exclude: ["@atelier/core"] } } },
	// Sandboxed preload scripts must be CommonJS.
	preload: { build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } } },
	renderer: { plugins: [react()] },
});
