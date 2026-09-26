import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		port: 3000,
		host: true,
		hmr: {
			overlay: true,
		},
	},
	build: {
		target: "esnext",
		minify: "esbuild",
		sourcemap: true,
	},
	test: {
		// Unit tests sit next to the code they test; browser tests live in tests/e2e (Playwright).
		include: ["src/**/*.test.ts"],
		environment: "node",
	},
});
