import type { NextConfig } from "next";

const config: NextConfig = {
	poweredByHeader: false,
	// The passkey backend's SQLite driver is a native Node addon: it must be
	// loaded from node_modules at runtime, never bundled. (Next already treats
	// better-sqlite3 this way; listed here so the dependency is explicit.)
	serverExternalPackages: ["better-sqlite3"],
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
