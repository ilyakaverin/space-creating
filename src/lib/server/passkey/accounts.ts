/**
 * Accounts and their passkeys — docs/passkey-backend-requirements.md §8.
 *
 * Plain data access: no WebAuthn logic lives here. Duplicate usernames and
 * credential IDs are turned into API errors, so a race never surfaces as a
 * 500 (BR-DATA-4).
 */
import type { Sql } from "./database";
import { ApiError } from "./errors";
import { nameKey } from "./validation";

/** The user as the API returns it; `id` is the WebAuthn user handle (BR-GEN-5). */
export interface User {
	id: string;
	/** The username as typed at registration. */
	name: string;
}

export interface StoredCredential {
	id: string;
	userId: string;
	publicKey: Uint8Array;
	algorithm: number;
	counter: number;
	transports: string[];
	backupEligible: boolean;
	backedUp: boolean;
}

export interface NewCredential extends StoredCredential {
	aaguid: string;
}

interface CredentialRow {
	id: string;
	user_id: string;
	public_key: Uint8Array;
	algorithm: number;
	counter: number;
	transports: string[];
	backup_eligible: boolean;
	backed_up: boolean;
}

export interface AccountStore {
	findUser(id: string): Promise<User | null>;
	/** Case-insensitive, like the uniqueness rule. */
	findUserByName(name: string): Promise<User | null>;
	/** Throws `username_taken` if the name was registered meanwhile. */
	createUser(user: User): Promise<void>;
	findCredential(id: string): Promise<StoredCredential | null>;
	/** The account's passkeys, oldest first, for `allowCredentials`. */
	listCredentials(
		userId: string,
	): Promise<{ id: string; transports: string[] }[]>;
	/** Throws `verification_failed` if the credential ID is already stored. */
	addCredential(credential: NewCredential): Promise<void>;
	/**
	 * Stores the counter and backup state after a verified sign-in. Resolves
	 * to false, changing nothing, if the counter did not grow (BR-WA-15).
	 */
	recordSignIn(
		id: string,
		update: { counter: number; backedUp: boolean },
	): Promise<boolean>;
}

/** Postgres's unique_violation: the key already exists. */
const isDuplicateKey = (error: unknown): boolean =>
	error instanceof Error && "code" in error && error.code === "23505";

export const createAccountStore = (
	sql: Sql,
	now: () => number,
): AccountStore => ({
	async findUser(id) {
		const { rows } = await sql.query<User>(
			"SELECT id, name FROM users WHERE id = $1",
			[id],
		);
		return rows[0] ?? null;
	},

	async findUserByName(name) {
		const { rows } = await sql.query<User>(
			"SELECT id, name FROM users WHERE name_key = $1",
			[nameKey(name)],
		);
		return rows[0] ?? null;
	},

	async createUser(user) {
		try {
			await sql.query(
				"INSERT INTO users (id, name, name_key, created_at) VALUES ($1, $2, $3, $4)",
				[user.id, user.name, nameKey(user.name), new Date(now())],
			);
		} catch (error) {
			// The handle is 32 random bytes, so a duplicate can only be the name.
			if (isDuplicateKey(error)) {
				throw new ApiError(
					"username_taken",
					`${user.name} was registered while this ceremony was running.`,
				);
			}
			throw error;
		}
	},

	async findCredential(id) {
		const { rows } = await sql.query<CredentialRow>(
			`SELECT id, user_id, public_key, algorithm, counter, transports, backup_eligible, backed_up
			FROM credentials WHERE id = $1`,
			[id],
		);
		const row = rows[0];
		if (!row) {
			return null;
		}
		return {
			id: row.id,
			userId: row.user_id,
			publicKey: new Uint8Array(row.public_key),
			algorithm: row.algorithm,
			counter: row.counter,
			transports: row.transports,
			backupEligible: row.backup_eligible,
			backedUp: row.backed_up,
		};
	},

	async listCredentials(userId) {
		const { rows } = await sql.query<{ id: string; transports: string[] }>(
			"SELECT id, transports FROM credentials WHERE user_id = $1 ORDER BY created_at",
			[userId],
		);
		return rows;
	},

	async addCredential(credential) {
		try {
			await sql.query(
				`INSERT INTO credentials
					(id, user_id, public_key, algorithm, counter, transports, aaguid, backup_eligible, backed_up, created_at)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
				[
					credential.id,
					credential.userId,
					Buffer.from(credential.publicKey),
					credential.algorithm,
					credential.counter,
					credential.transports,
					credential.aaguid,
					credential.backupEligible,
					credential.backedUp,
					new Date(now()),
				],
			);
		} catch (error) {
			if (isDuplicateKey(error)) {
				throw new ApiError(
					"verification_failed",
					"This passkey is already registered.",
				);
			}
			throw error;
		}
	},

	async recordSignIn(id, { counter, backedUp }) {
		// Compare-and-set in one statement, so two concurrent sign-ins can never
		// move the counter backwards. It must grow, except for passkeys that
		// never count (synced passkeys report 0 every time).
		const { rowCount } = await sql.query(
			`UPDATE credentials SET counter = $2, backed_up = $3, last_used_at = $4
			WHERE id = $1 AND (counter < $2 OR (counter = 0 AND $2 = 0))`,
			[id, counter, backedUp, new Date(now())],
		);
		return rowCount === 1;
	},
});
