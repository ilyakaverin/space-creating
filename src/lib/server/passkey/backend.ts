/**
 * Wires the backend together: one database, the stores on top of it, the
 * rate limiter and the log. Everything is passed in explicitly, so tests can
 * build a backend with an in-memory database and a fake clock.
 */
import { type AccountStore, createAccountStore } from "./accounts";
import { type ChallengeStore, createChallengeStore } from "./challenges";
import type { PasskeyConfig } from "./config";
import { type Db, openDatabase } from "./database";
import { type SecurityLog, consoleSecurityLog } from "./log";
import { type RateLimiter, createRateLimiter } from "./rate-limit";
import { type SessionStore, createSessionStore } from "./sessions";

export interface PasskeyBackend {
	config: PasskeyConfig;
	db: Db;
	accounts: AccountStore;
	challenges: ChallengeStore;
	sessions: SessionStore;
	limiter: RateLimiter;
	log: SecurityLog;
	now: () => number;
}

export interface BackendOptions {
	/** Defaults to opening `config.databasePath`. */
	db?: Db;
	now?: () => number;
	log?: SecurityLog;
}

export const createPasskeyBackend = (
	config: PasskeyConfig,
	options: BackendOptions = {},
): PasskeyBackend => {
	const now = options.now ?? Date.now;
	const db = options.db ?? openDatabase(config.databasePath);
	return {
		config,
		db,
		accounts: createAccountStore(db, now),
		challenges: createChallengeStore(db, now),
		sessions: createSessionStore(db, { ttlMs: config.sessionTtlMs, now }),
		limiter: createRateLimiter(now),
		log: options.log ?? consoleSecurityLog,
		now,
	};
};

/** Drops expired challenges, sessions and rate-limit windows (BR-OPS-2). */
export const cleanupExpired = (backend: PasskeyBackend): void => {
	backend.challenges.deleteExpired();
	backend.sessions.deleteExpired();
	backend.limiter.prune();
};
