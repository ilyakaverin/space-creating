/**
 * Wires the backend together: one database, the stores on top of it, the
 * rate limiter and the log. Everything is passed in explicitly, so tests can
 * build a backend on an in-memory database with a fake clock.
 */
import { type AccountStore, createAccountStore } from "./accounts";
import { type ChallengeStore, createChallengeStore } from "./challenges";
import type { PasskeyConfig } from "./config";
import type { Db, Sql } from "./database";
import { type SecurityLog, consoleSecurityLog } from "./log";
import { type RateLimiter, createRateLimiter } from "./rate-limit";
import { type SessionStore, createSessionStore } from "./sessions";

export interface Stores {
	accounts: AccountStore;
	challenges: ChallengeStore;
	sessions: SessionStore;
	limiter: RateLimiter;
}

export interface PasskeyBackend extends Stores {
	config: PasskeyConfig;
	db: Db;
	log: SecurityLog;
	now: () => number;
	/**
	 * Runs `fn` in one database transaction, with stores whose queries all
	 * belong to it: either every write in `fn` happens, or none does.
	 */
	transaction<T>(fn: (stores: Stores) => Promise<T>): Promise<T>;
}

export interface BackendOptions {
	db: Db;
	now?: () => number;
	log?: SecurityLog;
}

export const createPasskeyBackend = (
	config: PasskeyConfig,
	{ db, now = Date.now, log = consoleSecurityLog }: BackendOptions,
): PasskeyBackend => {
	const storesOn = (sql: Sql): Stores => ({
		accounts: createAccountStore(sql, now),
		challenges: createChallengeStore(sql, now),
		sessions: createSessionStore(sql, { ttlMs: config.sessionTtlMs, now }),
		limiter: createRateLimiter(sql, now),
	});
	return {
		...storesOn(db),
		config,
		db,
		log,
		now,
		transaction: (fn) => db.transaction((tx) => fn(storesOn(tx))),
	};
};

/** Drops expired challenges, sessions and rate-limit windows (BR-OPS-2). */
export const cleanupExpired = async (
	backend: PasskeyBackend,
): Promise<void> => {
	await backend.challenges.deleteExpired();
	await backend.sessions.deleteExpired();
	await backend.limiter.prune();
};
