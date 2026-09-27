/**
 * SQLite storage — docs/passkey-backend-requirements.md §8.
 *
 * better-sqlite3 is synchronous: a query runs to completion before the next
 * line, and `db.transaction(fn)` makes a group of writes all-or-nothing.
 * That keeps the ceremony code free of locking concerns.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

/**
 * Schema versions, applied in order and tracked in `PRAGMA user_version`.
 * Never edit a migration that has run somewhere; append a new one instead.
 *
 * Tables are STRICT, so SQLite rejects a value of the wrong type instead of
 * silently storing it. Times are Unix milliseconds (UTC).
 */
const MIGRATIONS: string[] = [
	`
	-- One row per account. The primary key is the WebAuthn user handle
	-- (base64url): random bytes the authenticator stores with the passkey and
	-- hands back at sign-in, so a passkey can be traced to its account.
	CREATE TABLE users (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		-- Lower-cased NFC form of the name: makes "Alice" and "alice" one account.
		name_key TEXT NOT NULL UNIQUE,
		display_name TEXT NOT NULL,
		created_at INTEGER NOT NULL
	) STRICT;

	-- One row per passkey. A user can have several (phone, laptop, security key).
	CREATE TABLE credentials (
		-- Credential ID chosen by the authenticator, base64url.
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		-- COSE-encoded public key; the private key never leaves the authenticator.
		public_key BLOB NOT NULL,
		-- COSE algorithm, e.g. -7 for ES256.
		algorithm INTEGER NOT NULL,
		-- Signature counter, used to spot cloned authenticators. Synced passkeys stay at 0.
		counter INTEGER NOT NULL,
		-- JSON array such as ["internal","hybrid"]; sent back in excludeCredentials.
		transports TEXT NOT NULL,
		-- Authenticator model ID, useful for naming passkeys in a future management page.
		aaguid TEXT NOT NULL,
		-- Whether the passkey can be synced (BE flag) and currently is (BS flag).
		backup_eligible INTEGER NOT NULL,
		backed_up INTEGER NOT NULL,
		name TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		last_used_at INTEGER
	) STRICT;
	CREATE INDEX credentials_user_id ON credentials(user_id);

	-- One row per signed-in browser. Only the SHA-256 of the cookie token is kept,
	-- so a leaked database cannot be turned into working sessions.
	CREATE TABLE sessions (
		token_hash TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL,
		last_seen_at INTEGER NOT NULL,
		user_agent TEXT
	) STRICT;
	CREATE INDEX sessions_user_id ON sessions(user_id);
	CREATE INDEX sessions_expires_at ON sessions(expires_at);

	-- Challenges handed out by the options endpoints and not yet used.
	-- A row is deleted the moment a verify request presents it (single use).
	CREATE TABLE challenges (
		challenge TEXT PRIMARY KEY,
		-- Random ID from the flow cookie: ties the challenge to one browser.
		flow_id TEXT NOT NULL,
		type TEXT NOT NULL CHECK (type IN ('registration', 'authentication')),
		-- The account a registration would create; not in users until verified,
		-- so merely asking for options cannot reserve a username.
		user_handle TEXT,
		user_name TEXT,
		user_display_name TEXT,
		-- Set when a signed-in user adds a passkey to their own account.
		session_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL
	) STRICT;
	CREATE INDEX challenges_flow_id ON challenges(flow_id);
	CREATE INDEX challenges_expires_at ON challenges(expires_at);
	`,
];

/** Brings the schema up to date; each migration runs in its own transaction. */
export const migrate = (db: Db): void => {
	const current = db.pragma("user_version", { simple: true }) as number;
	if (current > MIGRATIONS.length) {
		throw new Error(
			`The database schema (version ${current}) is newer than this code (version ${MIGRATIONS.length}).`,
		);
	}
	for (let version = current; version < MIGRATIONS.length; version++) {
		db.transaction(() => {
			db.exec(MIGRATIONS[version]);
			db.pragma(`user_version = ${version + 1}`);
		})();
	}
};

/** Opens (creating if needed) and migrates the database. Pass ":memory:" for a throwaway one. */
export const openDatabase = (path: string): Db => {
	if (path !== ":memory:") {
		mkdirSync(dirname(path), { recursive: true });
	}
	const db = new Database(path);
	// WAL lets readers work while a write is in progress, and survives crashes well.
	db.pragma("journal_mode = WAL");
	// SQLite ignores REFERENCES clauses unless this is switched on, per connection.
	db.pragma("foreign_keys = ON");
	// Wait instead of failing when another connection (e.g. a test) holds the write lock.
	db.pragma("busy_timeout = 5000");
	migrate(db);
	return db;
};
