import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Unit tests sit next to the code they test; browser tests live in tests/e2e (Playwright).
		include: ["src/**/*.test.ts"],
		environment: "node",
	},
});
