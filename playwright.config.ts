import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests for the passkey backend (docs/passkey-backend-requirements.md
 * BR-TEST-2/3): the production build runs against a Postgres database of
 * its own, and Chromium signs in with a virtual authenticator.
 */
const PORT = 4300;
export const BASE_URL = `http://localhost:${PORT}`;

/**
 * Never the site's real database: the tests fill it with accounts. Required,
 * because without it the server would fall back to DATABASE_URL from
 * .env.local — which, after `vercel env pull`, is Neon.
 */
export const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL;
if (!E2E_DATABASE_URL) {
	throw new Error(
		"Set E2E_DATABASE_URL to a throwaway Postgres database, e.g. postgresql://postgres:postgres@localhost/passkeys_e2e. The tests write to it.",
	);
}

export default defineConfig({
	testDir: "tests/e2e",
	// One server and one database: tests run one after another.
	workers: 1,
	use: {
		baseURL: BASE_URL,
		browserName: "chromium",
	},
	webServer: {
		command: "pnpm build && pnpm start",
		url: `${BASE_URL}/api/health`,
		reuseExistingServer: false,
		timeout: 300_000,
		env: {
			PORT: String(PORT),
			PASSKEY_ORIGIN: BASE_URL,
			DATABASE_URL: E2E_DATABASE_URL,
			// Each test sends its own "client address" in this header, so the
			// per-IP rate limits of one test never affect another.
			PASSKEY_CLIENT_IP_HEADER: "x-test-client-ip",
			NEXT_TELEMETRY_DISABLED: "1",
		},
	},
});
