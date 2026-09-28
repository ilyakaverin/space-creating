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
import { connectDatabase, migrateOnFirstUse } from "./database";

const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Next.js can load this module several times in one process: hot reload in
 * development, and separate bundles for instrumentation.ts and the route
 * handlers. The one backend per process therefore lives on globalThis, so
 * they all share one connection pool. Changing the configuration needs a
 * restart (on Vercel, a redeploy).
 */
const holder = globalThis as typeof globalThis & {
	passkeyBackend?: PasskeyBackend;
	passkeyNextCleanup?: number;
};

/**
 * The backend of this process, created on first use. Throws a ConfigError
 * for bad configuration, and does so again on every call until it is fixed.
 * Creating it opens no connection: the pool connects, and the schema is
 * brought up to date, when the first query needs the database.
 */
export const passkeyBackend = (): PasskeyBackend => {
	if (!holder.passkeyBackend) {
		const config = parseConfig(process.env, {
			dev: process.env.NODE_ENV === "development",
		});
		holder.passkeyBackend = createPasskeyBackend(config, {
			db: migrateOnFirstUse(connectDatabase(config.databaseUrl)),
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
 * Called by src/instrumentation.ts when the server starts: bad
 * configuration is reported right away instead of at the first sign-in
 * (BR-OPS-1).
 *
 * A self-hosted server then also connects and migrates, and stops on bad
 * configuration. On Vercel neither: there is no server to stop, and Next.js
 * holds back the first request of every cold start until this returns — so
 * waiting for the database here would delay even requests that do not need
 * it. The first query connects instead.
 */
export const startPasskeyBackend = async (): Promise<void> => {
	// `next build` may run instrumentation too; the build needs no database.
	if (process.env.NEXT_PHASE === "phase-production-build") {
		return;
	}
	const onVercel = Boolean(process.env.VERCEL);
	try {
		const backend = passkeyBackend();
		if (!onVercel) {
			await backend.db.query("SELECT 1");
		}
	} catch (error) {
		if (error instanceof ConfigError) {
			// Just the list of problems, not a stack trace through compiled code.
			console.error(error.message);
			if (process.env.NODE_ENV === "production" && !onVercel) {
				process.exit(1);
			}
			return;
		}
		console.error(
			"[passkey] The database is unreachable; each request will try again:",
			error,
		);
	}
};
