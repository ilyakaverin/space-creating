/**
 * Starting the backend inside the running Next.js server. This file,
 * `http.ts` and `cookies.ts` are the only ones that know about Next.js; the
 * rest is plain TypeScript.
 */
import "server-only";
import {
	type PasskeyBackend,
	cleanupExpired,
	createPasskeyBackend,
} from "./backend";
import { ConfigError, parseConfig } from "./config";

/** Where the routes live: src/app/api/passkey. */
export const API_PATH = "/api/passkey";
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Next.js writes NEXT_PUBLIC_ variables into the code at build time, in the
 * server bundle as in the browser one, so both sides always agree on the
 * mode. Only the full `process.env.NEXT_PUBLIC_…` expression is replaced.
 */
const configuredApiUrl = (): string =>
	process.env.NEXT_PUBLIC_PASSKEY_API_URL?.trim().replace(/\/+$/, "") ?? "";

/**
 * The built-in backend runs only when the frontend is pointed at it. Without
 * NEXT_PUBLIC_PASSKEY_API_URL the frontend keeps passkeys in the browser and
 * the server needs no configuration or database at all.
 */
export const isBackendEnabled = (): boolean => configuredApiUrl() === API_PATH;

/**
 * Next.js can load this module several times in one process: hot reload in
 * development, and separate bundles for instrumentation.ts and the route
 * handlers. The one backend per process therefore lives on globalThis, so
 * they all share one database connection, rate limiter and cleanup timer.
 * Changing the configuration needs a server restart.
 */
const holder = globalThis as typeof globalThis & {
	passkeyBackend?: PasskeyBackend;
	passkeyBackendOffWarned?: boolean;
};

/**
 * The cleanup runs on a timer, outside any request: an error there (a full
 * disk, a locked database) would otherwise crash the whole server. It is
 * logged instead, and the next run tries again.
 */
const cleanupSafely = (backend: PasskeyBackend): void => {
	try {
		cleanupExpired(backend);
	} catch (error) {
		console.error("[passkey] cleanup of expired rows failed:", error);
	}
};

/**
 * Validates the configuration, opens and migrates the database, and starts
 * the periodic cleanup. Throws on bad configuration so the server does not
 * start half-working (BR-CONF-1, BR-OPS-1). Returns null when disabled.
 */
export const passkeyBackend = (): PasskeyBackend | null => {
	// `next build` loads the route modules to analyse them; no database then.
	if (process.env.NEXT_PHASE === "phase-production-build") {
		return null;
	}
	if (!isBackendEnabled()) {
		// Pointing the frontend at a different URL is legitimate (a separate
		// backend), but "https://this-site/api/passkey" would silently leave
		// this one off, so say so once.
		if (configuredApiUrl() && !holder.passkeyBackendOffWarned) {
			holder.passkeyBackendOffWarned = true;
			console.warn(
				`[passkey] The built-in backend is off: NEXT_PUBLIC_PASSKEY_API_URL is "${configuredApiUrl()}", not "${API_PATH}".`,
			);
		}
		return null;
	}
	if (!holder.passkeyBackend) {
		const backend = createPasskeyBackend(
			parseConfig(process.env, {
				dev: process.env.NODE_ENV === "development",
			}),
		);
		// At startup a failure should stop the server, so no safety net here.
		cleanupExpired(backend);
		// unref: the timer alone must not keep the process alive on shutdown.
		setInterval(() => cleanupSafely(backend), CLEANUP_INTERVAL_MS).unref();
		holder.passkeyBackend = backend;
	}
	return holder.passkeyBackend;
};

/**
 * Called by src/instrumentation.ts at server start. With the passkey backend
 * enabled, bad configuration or an unusable database stops the server here
 * instead of failing on the first sign-in (BR-OPS-1).
 */
export const startPasskeyBackend = (): void => {
	try {
		passkeyBackend();
	} catch (error) {
		if (error instanceof ConfigError && process.env.NODE_ENV === "production") {
			// Just the list of problems, not a stack trace through compiled code.
			console.error(error.message);
			process.exit(1);
		}
		throw error;
	}
};
