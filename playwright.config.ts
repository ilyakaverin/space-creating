import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests for the passkey backend (docs/passkey-backend-requirements.md
 * BR-TEST-2/3): the production build runs in backend mode against a throwaway
 * SQLite file, and Chromium signs in with a virtual authenticator.
 */
const PORT = 4300;
export const BASE_URL = `http://localhost:${PORT}`;

// Set once in the runner; worker processes inherit it, so tests can open the same file.
process.env.E2E_DATABASE_PATH ??= join(
	tmpdir(),
	`space-creating-e2e-${Date.now()}.sqlite`,
);

export default defineConfig({
	testDir: "tests/e2e",
	// One server and one database: tests run one after another.
	workers: 1,
	use: {
		baseURL: BASE_URL,
		browserName: "chromium",
		// Keep every request visible to the tests instead of a service worker.
		serviceWorkers: "block",
	},
	webServer: {
		// NEXT_PUBLIC_ variables are fixed at build time, so the tests build their own.
		command: "pnpm build && pnpm start",
		url: `${BASE_URL}/api/health`,
		reuseExistingServer: false,
		timeout: 300_000,
		env: {
			PORT: String(PORT),
			PASSKEY_ORIGIN: BASE_URL,
			NEXT_PUBLIC_PASSKEY_API_URL: "/api/passkey",
			DATABASE_PATH: process.env.E2E_DATABASE_PATH,
			// Each test sends its own "client address" in this header, so the
			// per-IP rate limits of one test never affect another.
			PASSKEY_CLIENT_IP_HEADER: "x-test-client-ip",
			NEXT_TELEMETRY_DISABLED: "1",
		},
	},
});
