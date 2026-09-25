import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

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
});
