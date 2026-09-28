import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Unit tests sit next to the code they test; browser tests live in tests/e2e (Playwright).
		include: ["src/**/*.test.ts"],
		environment: "node",
		// The database tests start PGlite (Postgres in WebAssembly) once per
		// file, which takes a few seconds when all files start at once.
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
