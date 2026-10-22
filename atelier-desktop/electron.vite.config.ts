import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

export const CONTENT_SECURITY_POLICY = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";

/**
 * Adds the Content-Security-Policy to the built renderer only: in development
 * React's refresh preamble is an inline script and HMR needs a WebSocket,
 * which this policy would block.
 */
function contentSecurityPolicy(): Plugin {
	return {
		name: "atelier-csp",
		apply: "build",
		transformIndexHtml: () => [
			{
				tag: "meta",
				attrs: { "http-equiv": "Content-Security-Policy", content: CONTENT_SECURITY_POLICY },
				injectTo: "head-prepend",
			},
		],
	};
}

export default defineConfig({
	// @atelier/core is TypeScript source: bundle it into main instead of loading it at runtime.
	main: { build: { externalizeDeps: { exclude: ["@atelier/core"] } } },
	// Sandboxed preload scripts must be CommonJS.
	preload: { build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } } },
	renderer: { plugins: [react(), contentSecurityPolicy()] },
});
