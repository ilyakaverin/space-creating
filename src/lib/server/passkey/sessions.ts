/**
 * Sessions — docs/passkey-backend-requirements.md §6.1 (FR-AUTH-5, FR-SEC-5).
 *
 * A session is an opaque random token in an httpOnly cookie plus a database
 * row keyed by the token's SHA-256. The browser's JavaScript never sees the
 * token, and the database never holds it in usable form.
 */
import { createHash, randomBytes } from "node:crypto";
import type { User } from "./accounts";
import type { Db } from "./database";

/** Refreshing last_seen_at on every request would turn each read into a write. */
const LAST_SEEN_RESOLUTION_MS = 60 * 60 * 1000;
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export interface NewSession {
	/** Goes into the cookie and nowhere else. */
	token: string;
	expiresAt: number;
}

export interface ActiveSession {
	tokenHash: string;
	user: User;
	expiresAt: number;
	/** The expiry moved forward, so the cookie must be sent again. */
	refreshed: boolean;
}

export interface SessionStore {
	create(userId: string, userAgent: string | null): NewSession;
	/** Returns the session for a cookie token, or null if unknown or expired. */
	validate(token: string): ActiveSession | null;
	revoke(tokenHash: string): void;
	deleteExpired(): number;
}

export const hashToken = (token: string): string =>
	createHash("sha256").update(token).digest("hex");

export const createSessionStore = (
	db: Db,
	{ ttlMs, now }: { ttlMs: number; now: () => number },
): SessionStore => {
	const insert = db.prepare(`
		INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent)
		VALUES (?, ?, ?, ?, ?, ?)
	`);
	const select = db.prepare(`
		SELECT s.token_hash, s.expires_at, s.last_seen_at, u.id, u.name, u.display_name
		FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.token_hash = ?
	`);
	const extend = db.prepare(
		"UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE token_hash = ?",
	);
	const touch = db.prepare(
		"UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?",
	);
	const remove = db.prepare("DELETE FROM sessions WHERE token_hash = ?");
	const removeExpired = db.prepare(
		"DELETE FROM sessions WHERE expires_at <= ?",
	);

	return {
		create(userId, userAgent) {
			// 32 random bytes: as unguessable as the challenge, 43 base64url characters.
			const token = randomBytes(32).toString("base64url");
			const createdAt = now();
			const expiresAt = createdAt + ttlMs;
			insert.run(
				hashToken(token),
				userId,
				createdAt,
				expiresAt,
				createdAt,
				userAgent?.slice(0, 256) ?? null,
			);
			return { token, expiresAt };
		},

		validate(token) {
			if (!TOKEN_FORMAT.test(token)) {
				return null;
			}
			const tokenHash = hashToken(token);
			const row = select.get(tokenHash) as
				| {
						token_hash: string;
						expires_at: number;
						last_seen_at: number;
						id: string;
						name: string;
						display_name: string;
				  }
				| undefined;
			if (!row) {
				return null;
			}
			const time = now();
			if (row.expires_at <= time) {
				remove.run(tokenHash);
				return null;
			}
			let expiresAt = row.expires_at;
			let refreshed = false;
			// Sliding expiry: an active user is never signed out, an idle one is
			// after one TTL. Extending only past the halfway mark keeps writes rare.
			if (expiresAt - time < ttlMs / 2) {
				expiresAt = time + ttlMs;
				refreshed = true;
				extend.run(expiresAt, time, tokenHash);
			} else if (time - row.last_seen_at >= LAST_SEEN_RESOLUTION_MS) {
				touch.run(time, tokenHash);
			}
			return {
				tokenHash,
				user: { id: row.id, name: row.name, displayName: row.display_name },
				expiresAt,
				refreshed,
			};
		},

		revoke(tokenHash) {
			remove.run(tokenHash);
		},

		deleteExpired() {
			return removeExpired.run(now()).changes;
		},
	};
};
