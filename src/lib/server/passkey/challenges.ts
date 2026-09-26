/**
 * Challenges — docs/passkey-backend-requirements.md §5 (FR-SEC-3).
 *
 * A challenge is the random value the authenticator signs. It proves a
 * response was made for *this* request and not replayed from an earlier one,
 * which only holds if the server issued it, ties it to one browser, accepts
 * it once, and not for long.
 */
import type { Db } from "./database";
import { ApiError } from "./errors";

export type CeremonyType = "registration" | "authentication";

/** How long the browser prompt may stay open; sent as `timeout` in the options. */
export const CEREMONY_TIMEOUT_MS = 300_000;
/** Extra time for the verify request to arrive after the prompt closes. */
const VERIFY_GRACE_MS = 30_000;
export const CHALLENGE_TTL_MS = CEREMONY_TIMEOUT_MS + VERIFY_GRACE_MS;
/**
 * Outstanding challenges kept per browser. The autofill request and a
 * button-triggered ceremony overlap briefly, so one is not enough; older
 * ones beyond this belong to requests the frontend already aborted.
 */
export const MAX_CHALLENGES_PER_FLOW = 5;

/** The account a registration challenge would create once verified. */
export interface PendingUser {
	id: string;
	name: string;
	displayName: string;
}

export interface ChallengeRecord {
	challenge: string;
	type: CeremonyType;
	pendingUser: PendingUser | null;
	/** Set when a signed-in user adds a passkey to their account. */
	sessionUserId: string | null;
	expiresAt: number;
}

interface ChallengeRow {
	challenge: string;
	type: CeremonyType;
	user_handle: string | null;
	user_name: string | null;
	user_display_name: string | null;
	session_user_id: string | null;
	expires_at: number;
}

export interface IssueChallenge {
	challenge: string;
	flowId: string;
	type: CeremonyType;
	pendingUser?: PendingUser | null;
	sessionUserId?: string | null;
}

export interface ChallengeStore {
	issue(input: IssueChallenge): void;
	/** Uses the challenge up and returns it, or throws `verification_failed` / `challenge_expired`. */
	redeem(input: {
		challenge: string;
		flowId: string | null;
		type: CeremonyType;
	}): ChallengeRecord;
	/** Removes expired rows; returns how many. */
	deleteExpired(): number;
}

export const createChallengeStore = (
	db: Db,
	now: () => number,
): ChallengeStore => {
	const insert = db.prepare(`
		INSERT INTO challenges
			(challenge, flow_id, type, user_handle, user_name, user_display_name, session_user_id, created_at, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	// rowid grows with every insert, so "newest N" is simply the N largest rowids.
	const keepNewest = db.prepare(`
		DELETE FROM challenges
		WHERE flow_id = ?
			AND rowid NOT IN (
				SELECT rowid FROM challenges WHERE flow_id = ? ORDER BY rowid DESC LIMIT ?
			)
	`);
	// Deleting and reading in one statement makes redemption atomic: two
	// requests presenting the same challenge can never both get the row.
	const take = db.prepare(`
		DELETE FROM challenges WHERE challenge = ? AND flow_id = ? RETURNING *
	`);
	const removeExpired = db.prepare(
		"DELETE FROM challenges WHERE expires_at <= ?",
	);

	return {
		issue({ challenge, flowId, type, pendingUser, sessionUserId }) {
			const createdAt = now();
			db.transaction(() => {
				insert.run(
					challenge,
					flowId,
					type,
					pendingUser?.id ?? null,
					pendingUser?.name ?? null,
					pendingUser?.displayName ?? null,
					sessionUserId ?? null,
					createdAt,
					createdAt + CHALLENGE_TTL_MS,
				);
				keepNewest.run(flowId, flowId, MAX_CHALLENGES_PER_FLOW);
			})();
		},

		redeem({ challenge, flowId, type }) {
			// Matching on flow_id too means a challenge copied into another
			// browser is neither accepted nor burnt for its real owner.
			const row = flowId
				? (take.get(challenge, flowId) as ChallengeRow | undefined)
				: undefined;
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
			// Expired rows linger until the periodic cleanup, which is what lets
			// the UI say "expired" instead of a vaguer failure.
			if (row.expires_at <= now()) {
				throw new ApiError(
					"challenge_expired",
					"The challenge expired before the ceremony finished.",
				);
			}
			return {
				challenge: row.challenge,
				type: row.type,
				pendingUser:
					row.user_handle && row.user_name && row.user_display_name
						? {
								id: row.user_handle,
								name: row.user_name,
								displayName: row.user_display_name,
							}
						: null,
				sessionUserId: row.session_user_id,
				expiresAt: row.expires_at,
			};
		},

		deleteExpired() {
			return removeExpired.run(now()).changes;
		},
	};
};
