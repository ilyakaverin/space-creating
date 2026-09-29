import type { NextConfig } from "next";

const config: NextConfig = {
	poweredByHeader: false,
	async redirects() {
		return [
			{
				// The old login page: signing in now happens on the home page.
				// Not permanent (307), so browsers do not cache it for good.
				source: "/login",
				destination: "/",
				permanent: false,
			},
		];
	},
	async headers() {
		return [
			{
				// Browsers check this file for updates on navigation; it must never
				// come from a cache, or a fixed worker would reach nobody.
				source: "/service-worker.js",
				headers: [
					{ key: "Cache-Control", value: "no-cache" },
					{ key: "Content-Type", value: "text/javascript; charset=utf-8" },
				],
			},
		];
	},
};

export default config;
