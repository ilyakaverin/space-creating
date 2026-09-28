/**
 * Sessions — docs/passkey-backend-requirements.md §6.1 (FR-AUTH-5, FR-SEC-5).
 *
 * A session is an opaque random token in an httpOnly cookie plus a database
 * row keyed by the token's SHA-256. The browser's JavaScript never sees the
 * token, and the database never holds it in usable form.
 */
import { createHash, randomBytes } from "node:crypto";
import type { User } from "./accounts";
import type { Sql } from "./database";

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
	create(userId: string, userAgent: string | null): Promise<NewSession>;
	/** Resolves to the session for a cookie token, or null if unknown or expired. */
	validate(token: string): Promise<ActiveSession | null>;
	revoke(tokenHash: string): Promise<void>;
	deleteExpired(): Promise<number>;
}

export const hashToken = (token: string): string =>
	createHash("sha256").update(token).digest("hex");

export const createSessionStore = (
	sql: Sql,
	{ ttlMs, now }: { ttlMs: number; now: () => number },
): SessionStore => {
	const revoke = async (tokenHash: string): Promise<void> => {
		await sql.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
	};

	return {
		async create(userId, userAgent) {
			// 32 random bytes: as unguessable as the challenge, 43 base64url characters.
			const token = randomBytes(32).toString("base64url");
			const createdAt = now();
			const expiresAt = createdAt + ttlMs;
			await sql.query(
				`INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent)
				VALUES ($1, $2, $3, $4, $3, $5)`,
				[
					hashToken(token),
					userId,
					new Date(createdAt),
					new Date(expiresAt),
					userAgent?.slice(0, 256) ?? null,
				],
			);
			return { token, expiresAt };
		},

		async validate(token) {
			if (!TOKEN_FORMAT.test(token)) {
				return null;
			}
			const tokenHash = hashToken(token);
			const { rows } = await sql.query<{
				expires_at: Date;
				last_seen_at: Date;
				id: string;
				name: string;
			}>(
				`SELECT s.expires_at, s.last_seen_at, u.id, u.name
				FROM sessions s JOIN users u ON u.id = s.user_id
				WHERE s.token_hash = $1`,
				[tokenHash],
			);
			const row = rows[0];
			if (!row) {
				return null;
			}
			const time = now();
			let expiresAt = row.expires_at.getTime();
			if (expiresAt <= time) {
				await revoke(tokenHash);
				return null;
			}
			let refreshed = false;
			// Sliding expiry: an active user is never signed out, an idle one is
			// after one TTL. Extending only past the halfway mark keeps writes rare.
			if (expiresAt - time < ttlMs / 2) {
				expiresAt = time + ttlMs;
				refreshed = true;
				await sql.query(
					"UPDATE sessions SET expires_at = $2, last_seen_at = $3 WHERE token_hash = $1",
					[tokenHash, new Date(expiresAt), new Date(time)],
				);
			} else if (time - row.last_seen_at.getTime() >= LAST_SEEN_RESOLUTION_MS) {
				await sql.query(
					"UPDATE sessions SET last_seen_at = $2 WHERE token_hash = $1",
					[tokenHash, new Date(time)],
				);
			}
			return {
				tokenHash,
				user: { id: row.id, name: row.name },
				expiresAt,
				refreshed,
			};
		},

		revoke,

		async deleteExpired() {
			const { rowCount } = await sql.query(
				"DELETE FROM sessions WHERE expires_at <= $1",
				[new Date(now())],
			);
			return rowCount;
		},
	};
};
