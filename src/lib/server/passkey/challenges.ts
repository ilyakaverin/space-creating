/**
 * Challenges — docs/passkey-backend-requirements.md §5 (FR-SEC-3).
 *
 * A challenge is the random value the authenticator signs. It proves a
 * response was made for *this* request and not replayed from an earlier one,
 * which only holds if the server issued it, ties it to one browser, accepts
 * it once, and not for long.
 */
import type { User } from "./accounts";
import type { Sql } from "./database";
import { ApiError } from "./errors";

export type CeremonyType = "registration" | "authentication";

/** How long the browser prompt may stay open; sent as `timeout` in the options. */
export const CEREMONY_TIMEOUT_MS = 300_000;
/** Extra time for the verify request to arrive after the prompt closes. */
const VERIFY_GRACE_MS = 30_000;
export const CHALLENGE_TTL_MS = CEREMONY_TIMEOUT_MS + VERIFY_GRACE_MS;
/**
 * Outstanding challenges kept per browser: enough for a retry or a second
 * tab. Older ones belong to attempts the user already gave up on.
 */
export const MAX_CHALLENGES_PER_FLOW = 5;
/**
 * Expired challenges are kept this long before cleanup deletes them, so a late
 * answer — say, from a laptop that slept with the prompt open — is told
 * "expired" rather than failing without a reason.
 */
export const EXPIRED_RETENTION_MS = 60 * 60 * 1000;

export interface ChallengeRecord {
	challenge: string;
	type: CeremonyType;
	/** For registration: the account to create once the passkey is verified. */
	pendingUser: User | null;
	expiresAt: number;
}

interface ChallengeRow {
	challenge: string;
	type: CeremonyType;
	user_id: string | null;
	user_name: string | null;
	expires_at: Date;
}

export interface IssueChallenge {
	challenge: string;
	flowId: string;
	type: CeremonyType;
	pendingUser?: User | null;
}

export interface ChallengeStore {
	issue(input: IssueChallenge): Promise<void>;
	/** Uses the challenge up and returns it, or throws `verification_failed` / `challenge_expired`. */
	redeem(input: {
		challenge: string;
		flowId: string | null;
		type: CeremonyType;
	}): Promise<ChallengeRecord>;
	/** Removes rows expired for longer than EXPIRED_RETENTION_MS; resolves to how many. */
	deleteExpired(): Promise<number>;
}

export const createChallengeStore = (
	sql: Sql,
	now: () => number,
): ChallengeStore => ({
	async issue({ challenge, flowId, type, pendingUser }) {
		const createdAt = now();
		await sql.query(
			`INSERT INTO challenges (challenge, flow_id, type, user_id, user_name, created_at, expires_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			[
				challenge,
				flowId,
				type,
				pendingUser?.id ?? null,
				pendingUser?.name ?? null,
				new Date(createdAt),
				new Date(createdAt + CHALLENGE_TTL_MS),
			],
		);
		// No transaction needed: if this cleanup fails, a few extra rows wait
		// for the periodic one.
		await sql.query(
			`DELETE FROM challenges
			WHERE flow_id = $1
				AND seq NOT IN (
					SELECT seq FROM challenges WHERE flow_id = $1 ORDER BY seq DESC LIMIT $2
				)`,
			[flowId, MAX_CHALLENGES_PER_FLOW],
		);
	},

	async redeem({ challenge, flowId, type }) {
		// Deleting and reading in one statement makes redemption atomic: two
		// requests presenting the same challenge can never both get the row.
		// Matching on flow_id too means a challenge copied into another
		// browser is neither accepted nor burnt for its real owner.
		const { rows } = flowId
			? await sql.query<ChallengeRow>(
					`DELETE FROM challenges WHERE challenge = $1 AND flow_id = $2
					RETURNING challenge, type, user_id, user_name, expires_at`,
					[challenge, flowId],
				)
			: { rows: [] };
		const row = rows[0];
		if (!row) {
			throw new ApiError(
				"verification_failed",
				"The challenge is unknown, already used, or belongs to another browser.",
			);
		}
		if (row.type !== type) {
			throw new ApiError(
				"verification_failed",
				`A ${row.type} challenge was presented for ${type}.`,
			);
		}
		// Expired rows are kept for a while (EXPIRED_RETENTION_MS), which is
		// what lets the UI say "expired" instead of a vaguer failure.
		const expiresAt = row.expires_at.getTime();
		if (expiresAt <= now()) {
			throw new ApiError(
				"challenge_expired",
				"The challenge expired before the ceremony finished.",
			);
		}
		return {
			challenge: row.challenge,
			type: row.type,
			pendingUser:
				row.user_id && row.user_name
					? { id: row.user_id, name: row.user_name }
					: null,
			expiresAt,
		};
	},

	async deleteExpired() {
		const { rowCount } = await sql.query(
			"DELETE FROM challenges WHERE expires_at <= $1",
			[new Date(now() - EXPIRED_RETENTION_MS)],
		);
		return rowCount;
	},
});
