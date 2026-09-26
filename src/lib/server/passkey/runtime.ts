/**
 * Starting the backend inside the running SvelteKit server, and resolving the
 * session cookie on each request. This file and `http.ts` are the only ones
 * that read SvelteKit's `$env` / `$app` modules; the rest is plain TypeScript.
 */
import { building, dev } from "$app/environment";
import { env as privateEnv } from "$env/dynamic/private";
import { env as publicEnv } from "$env/dynamic/public";
import type { RequestEvent } from "@sveltejs/kit";
import {
	type PasskeyBackend,
	cleanupExpired,
	createPasskeyBackend,
} from "./backend";
import { parseConfig } from "./config";
import {
	clearSessionCookie,
	readSessionToken,
	setSessionCookie,
} from "./cookies";

/** Where the routes live: src/routes/api/passkey. */
export const API_PATH = "/api/passkey";
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * The built-in backend runs only when the frontend is pointed at it. Without
 * PUBLIC_PASSKEY_API_URL the frontend keeps passkeys in the browser and the
 * server needs no configuration or database at all.
 */
export const isBackendEnabled = (): boolean =>
	publicEnv.PUBLIC_PASSKEY_API_URL?.trim().replace(/\/+$/, "") === API_PATH;

/**
 * Kept on globalThis so Vite's hot reload in development reuses the open
 * database and cleanup timer instead of starting another. Changing the
 * configuration therefore needs a dev-server restart.
 */
const holder = globalThis as typeof globalThis & {
	passkeyBackend?: PasskeyBackend;
};

/**
 * Validates the configuration, opens and migrates the database, and starts
 * the periodic cleanup. Throws on bad configuration so the server does not
 * start half-working (BR-CONF-1, BR-OPS-1). Returns null when disabled.
 */
export const passkeyBackend = (): PasskeyBackend | null => {
	if (building || !isBackendEnabled()) {
		return null;
	}
	if (!holder.passkeyBackend) {
		const backend = createPasskeyBackend(parseConfig(privateEnv, { dev }));
		cleanupExpired(backend);
		// unref: the timer alone must not keep the process alive on shutdown.
		setInterval(() => cleanupExpired(backend), CLEANUP_INTERVAL_MS).unref();
		holder.passkeyBackend = backend;
	}
	return holder.passkeyBackend;
};

/**
 * Turns the session cookie into `event.locals.user` (BR-COOK-6). An unknown
 * or expired cookie is deleted; a session past half its lifetime gets a
 * fresh expiry and cookie (sliding expiry).
 */
export const resolvePasskeySession = (event: RequestEvent): void => {
	event.locals.user = null;
	event.locals.sessionTokenHash = null;
	const backend = passkeyBackend();
	if (!backend) {
		return;
	}
	const token = readSessionToken(event.cookies, backend.config);
	if (!token) {
		return;
	}
	const session = backend.sessions.validate(token);
	if (!session) {
		clearSessionCookie(event.cookies, backend.config);
		return;
	}
	if (session.refreshed) {
		setSessionCookie(event.cookies, backend.config, {
			token,
			expiresAt: session.expiresAt,
		});
	}
	event.locals.user = session.user;
	event.locals.sessionTokenHash = session.tokenHash;
};
