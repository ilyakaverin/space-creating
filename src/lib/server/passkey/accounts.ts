/**
 * Accounts and their passkeys — docs/passkey-backend-requirements.md §8.
 *
 * Plain data access: no WebAuthn logic lives here. Unique-constraint
 * violations are turned into API errors so a race never surfaces as a 500
 * (BR-DATA-4).
 */
import type { Db } from "./database";
import { ApiError } from "./errors";
import { nameKey } from "./validation";

/** The user as the API returns it; `id` is the WebAuthn user handle (BR-GEN-5). */
export interface User {
	id: string;
	name: string;
	displayName: string;
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

interface UserRow {
	id: string;
	name: string;
	display_name: string;
}

interface CredentialRow {
	id: string;
	user_id: string;
	public_key: Buffer;
	algorithm: number;
	counter: number;
	transports: string;
	backup_eligible: number;
	backed_up: number;
}

export interface AccountStore {
	findUser(id: string): User | null;
	findUserByName(name: string): User | null;
	/** Throws `username_taken` if the name was registered meanwhile. */
	createUser(user: User): void;
	/** Deleting a user cascades to credentials, sessions and pending challenges. */
	deleteUser(id: string): void;
	listCredentials(userId: string): { id: string; transports: string[] }[];
	findCredential(id: string): StoredCredential | null;
	/** Throws `verification_failed` if the credential ID is already stored. */
	addCredential(credential: NewCredential): void;
	recordSignIn(
		id: string,
		update: { counter: number; backedUp: boolean },
	): void;
}

const toUser = (row: UserRow): User => ({
	id: row.id,
	name: row.name,
	displayName: row.display_name,
});

const isConstraintError = (error: unknown): boolean =>
	error instanceof Error &&
	"code" in error &&
	String(error.code).startsWith("SQLITE_CONSTRAINT");

export const createAccountStore = (db: Db, now: () => number): AccountStore => {
	const selectUser = db.prepare(
		"SELECT id, name, display_name FROM users WHERE id = ?",
	);
	const selectUserByKey = db.prepare(
		"SELECT id, name, display_name FROM users WHERE name_key = ?",
	);
	const insertUser = db.prepare(
		"INSERT INTO users (id, name, name_key, display_name, created_at) VALUES (?, ?, ?, ?, ?)",
	);
	const removeUser = db.prepare("DELETE FROM users WHERE id = ?");
	const selectCredentialsOf = db.prepare(
		"SELECT id, transports FROM credentials WHERE user_id = ? ORDER BY created_at",
	);
	const selectCredential = db.prepare(`
		SELECT id, user_id, public_key, algorithm, counter, transports, backup_eligible, backed_up
		FROM credentials WHERE id = ?
	`);
	const insertCredential = db.prepare(`
		INSERT INTO credentials
			(id, user_id, public_key, algorithm, counter, transports, aaguid, backup_eligible, backed_up, name, created_at, last_used_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Passkey', ?, NULL)
	`);
	const updateAfterSignIn = db.prepare(
		"UPDATE credentials SET counter = ?, backed_up = ?, last_used_at = ? WHERE id = ?",
	);

	return {
		findUser(id) {
			const row = selectUser.get(id) as UserRow | undefined;
			return row ? toUser(row) : null;
		},

		findUserByName(name) {
			const row = selectUserByKey.get(nameKey(name)) as UserRow | undefined;
			return row ? toUser(row) : null;
		},

		createUser(user) {
			try {
				insertUser.run(
					user.id,
					user.name,
					nameKey(user.name),
					user.displayName,
					now(),
				);
			} catch (error) {
				if (isConstraintError(error)) {
					throw new ApiError(
						"username_taken",
						`${user.name} was registered while this ceremony was running.`,
					);
				}
				throw error;
			}
		},

		deleteUser(id) {
			removeUser.run(id);
		},

		listCredentials(userId) {
			const rows = selectCredentialsOf.all(userId) as {
				id: string;
				transports: string;
			}[];
			return rows.map((row) => ({
				id: row.id,
				transports: JSON.parse(row.transports) as string[],
			}));
		},

		findCredential(id) {
			const row = selectCredential.get(id) as CredentialRow | undefined;
			if (!row) {
				return null;
			}
			return {
				id: row.id,
				userId: row.user_id,
				publicKey: new Uint8Array(row.public_key),
				algorithm: row.algorithm,
				counter: row.counter,
				transports: JSON.parse(row.transports) as string[],
				backupEligible: row.backup_eligible === 1,
				backedUp: row.backed_up === 1,
			};
		},

		addCredential(credential) {
			try {
				insertCredential.run(
					credential.id,
					credential.userId,
					Buffer.from(credential.publicKey),
					credential.algorithm,
					credential.counter,
					JSON.stringify(credential.transports),
					credential.aaguid,
					credential.backupEligible ? 1 : 0,
					credential.backedUp ? 1 : 0,
					now(),
				);
			} catch (error) {
				if (isConstraintError(error)) {
					throw new ApiError(
						"verification_failed",
						"This passkey is already registered.",
					);
				}
				throw error;
			}
		},

		recordSignIn(id, { counter, backedUp }) {
			updateAfterSignIn.run(counter, backedUp ? 1 : 0, now(), id);
		},
	};
};
