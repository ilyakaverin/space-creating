/**
 * Starting the backend inside the running Next.js server. This file,
 * `http.ts` and `cookies.ts` are the only ones that know about Next.js; the
 * rest is plain TypeScript.
 */
import { after } from "next/server";
import "server-only";
import {
	type PasskeyBackend,
	cleanupExpired,
	createPasskeyBackend,
} from "./backend";
import { ConfigError, parseConfig } from "./config";
import { connectDatabase, migrate } from "./database";

const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Next.js can load this module several times in one process: hot reload in
 * development, and separate bundles for instrumentation.ts and the route
 * handlers. The one backend per process therefore lives on globalThis, so
 * they all share one connection pool. Changing the configuration needs a
 * restart (on Vercel, a redeploy).
 */
const holder = globalThis as typeof globalThis & {
	passkeyBackend?: Promise<PasskeyBackend>;
	passkeyNextCleanup?: number;
};

const start = async (): Promise<PasskeyBackend> => {
	const config = parseConfig(process.env, {
		dev: process.env.NODE_ENV === "development",
	});
	const db = connectDatabase(config.databaseUrl);
	try {
		await migrate(db);
	} catch (error) {
		await db.close().catch(() => undefined);
		throw error;
	}
	return createPasskeyBackend(config, { db });
};

/**
 * The backend of this process: validates the configuration, connects to
 * the database and brings its schema up to date, once. A failed start is
 * not kept, so the next request tries again — the database may only have
 * been unreachable for a moment.
 */
export const passkeyBackend = (): Promise<PasskeyBackend> => {
	if (!holder.passkeyBackend) {
		holder.passkeyBackend = start().catch((error: unknown) => {
			holder.passkeyBackend = undefined;
			throw error;
		});
	}
	return holder.passkeyBackend;
};

/**
 * Deletes expired rows (BR-OPS-2) at most every ten minutes per instance.
 * There is no timer: on Vercel a function instance only runs while it
 * serves requests. So a request schedules it with `after`, which runs once
 * the response has been sent and keeps the instance alive until it is done.
 */
export const scheduleCleanup = (backend: PasskeyBackend): void => {
	const time = backend.now();
	if (time < (holder.passkeyNextCleanup ?? 0)) {
		return;
	}
	holder.passkeyNextCleanup = time + CLEANUP_INTERVAL_MS;
	after(async () => {
		try {
			await cleanupExpired(backend);
		} catch (error) {
			console.error("[passkey] cleanup of expired rows failed:", error);
		}
	});
};

/**
 * Called by src/instrumentation.ts when the server starts, so a
 * self-hosted server with bad configuration stops right away instead of
 * failing on the first sign-in (BR-OPS-1). On Vercel there is no server to
 * stop: the problem is logged, and API requests fail until it is fixed.
 */
export const startPasskeyBackend = async (): Promise<void> => {
	// `next build` may run instrumentation too; the build needs no database.
	if (process.env.NEXT_PHASE === "phase-production-build") {
		return;
	}
	try {
		await passkeyBackend();
	} catch (error) {
		if (error instanceof ConfigError) {
			// Just the list of problems, not a stack trace through compiled code.
			console.error(error.message);
			if (process.env.NODE_ENV === "production" && !process.env.VERCEL) {
				process.exit(1);
			}
			return;
		}
		console.error(
			"[passkey] The backend could not start; each request will try again:",
			error,
		);
	}
};
