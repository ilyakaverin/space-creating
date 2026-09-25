/**
 * A relying party that lives in the browser: challenges are issued in memory,
 * accounts and public keys are kept in localStorage, the signed-in user in
 * sessionStorage, and assertions are verified with WebCrypto. It shows the
 * passkey ceremonies without a server, but it is not an authentication
 * boundary — anyone with devtools can edit the stored accounts or the session.
 * Set PUBLIC_PASSKEY_API_URL to use a backend instead.
 */
import { fromBase64Url, randomBase64Url } from "./encoding";
import { PasskeyError } from "./errors";
import type {
	AuthenticationResponseJSON,
	RegistrationResponseJSON,
	RelyingParty,
	User,
} from "./types";

const STORAGE_KEY = "space-creating:passkeys";
/** The single passkey stored by the first version of this page. */
const LEGACY_STORAGE_KEY = "space-creating:passkey";
const SESSION_KEY = "space-creating:passkey-session";
const ES256 = -7;
const RS256 = -257;
/** How long the browser prompt may stay open; a challenge is only accepted for as long. */
const TIMEOUT = 300_000;

interface StoredUser extends User {
	createdAt: number;
	/** Migrated from the first version, which never kept the user handle: it is learned at the next sign-in. */
	legacy?: true;
}

interface StoredCredential {
	/** Credential ID, base64url. */
	id: string;
	userId: string;
	/** SubjectPublicKeyInfo, base64url. */
	publicKey: string;
	algorithm: number;
	transports: string[];
	createdAt: number;
	lastUsedAt: number | null;
}

interface Database {
	users: StoredUser[];
	credentials: StoredCredential[];
}

interface LegacyPasskey {
	credentialId: string;
	publicKey: string | null;
	algorithm: number | null;
	userName: string;
	createdAt: number;
}

interface PendingChallenge {
	type: "webauthn.create" | "webauthn.get";
	expiresAt: number;
	/** The account a registration challenge was issued for. */
	user?: User;
}

interface ClientData {
	type: string;
	challenge: string;
	origin: string;
	crossOrigin?: boolean;
}

export interface LocalRelyingPartyOptions {
	rpName: string;
	rpId?: string;
	origin?: string;
}

const toUser = ({ id, name, displayName }: User): User => ({
	id,
	name,
	displayName,
});

const sameName = (a: string, b: string): boolean =>
	a.toLowerCase() === b.toLowerCase();

const parseJSON = <T>(raw: string | null): T | null => {
	if (!raw) {
		return null;
	}
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
};

const verificationFailed = (message: string) =>
	new PasskeyError("verification_failed", message);

const importPublicKey = (spki: string, algorithm: number): Promise<CryptoKey> =>
	crypto.subtle.importKey(
		"spki",
		fromBase64Url(spki),
		algorithm === ES256
			? { name: "ECDSA", namedCurve: "P-256" }
			: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["verify"],
	);

/** WebAuthn signs ES256 as an ASN.1 SEQUENCE of two INTEGERs; WebCrypto wants raw r||s. */
const derToRawSignature = (der: Uint8Array): Uint8Array<ArrayBuffer> => {
	const raw = new Uint8Array(64);
	let offset = 2;
	for (const half of [0, 32]) {
		offset += 1;
		const length = der[offset];
		offset += 1;
		const value = der.subarray(
			offset + Math.max(0, length - 32),
			offset + length,
		);
		raw.set(value, half + 32 - value.length);
		offset += length;
	}
	return raw;
};

const verifySignature = async (
	credential: StoredCredential,
	authenticatorData: Uint8Array<ArrayBuffer>,
	clientDataJSON: Uint8Array<ArrayBuffer>,
	signature: Uint8Array<ArrayBuffer>,
): Promise<boolean> => {
	try {
		const key = await importPublicKey(
			credential.publicKey,
			credential.algorithm,
		);
		const clientDataHash = new Uint8Array(
			await crypto.subtle.digest("SHA-256", clientDataJSON),
		);
		const signedData = new Uint8Array(
			authenticatorData.length + clientDataHash.length,
		);
		signedData.set(authenticatorData);
		signedData.set(clientDataHash, authenticatorData.length);
		return credential.algorithm === ES256
			? await crypto.subtle.verify(
					{ name: "ECDSA", hash: "SHA-256" },
					key,
					derToRawSignature(signature),
					signedData,
				)
			: await crypto.subtle.verify(
					{ name: "RSASSA-PKCS1-v1_5" },
					key,
					signature,
					signedData,
				);
	} catch {
		return false;
	}
};

export const createLocalRelyingParty = ({
	rpName,
	rpId = location.hostname,
	origin = location.origin,
}: LocalRelyingPartyOptions): RelyingParty => {
	const challenges = new Map<string, PendingChallenge>();

	const save = (db: Database): void =>
		localStorage.setItem(STORAGE_KEY, JSON.stringify(db));

	/** Folds the first version's single passkey into an account, once. */
	const migrateLegacy = (db: Database): void => {
		const legacy = parseJSON<LegacyPasskey>(
			localStorage.getItem(LEGACY_STORAGE_KEY),
		);
		localStorage.removeItem(LEGACY_STORAGE_KEY);
		if (
			!legacy?.publicKey ||
			legacy.algorithm === null ||
			db.credentials.some((credential) => credential.id === legacy.credentialId)
		) {
			return;
		}
		const user: StoredUser = {
			id: randomBase64Url(32),
			name: legacy.userName,
			displayName: legacy.userName,
			createdAt: legacy.createdAt,
			legacy: true,
		};
		db.users.push(user);
		db.credentials.push({
			id: legacy.credentialId,
			userId: user.id,
			publicKey: legacy.publicKey,
			algorithm: legacy.algorithm,
			transports: [],
			createdAt: legacy.createdAt,
			lastUsedAt: null,
		});
		save(db);
	};

	const load = (): Database => {
		const stored = parseJSON<Database>(localStorage.getItem(STORAGE_KEY));
		const db =
			Array.isArray(stored?.users) && Array.isArray(stored?.credentials)
				? stored
				: { users: [], credentials: [] };
		if (localStorage.getItem(LEGACY_STORAGE_KEY) !== null) {
			migrateLegacy(db);
		}
		return db;
	};

	const issueChallenge = (pending: Omit<PendingChallenge, "expiresAt">) => {
		const now = Date.now();
		for (const [value, entry] of challenges) {
			if (entry.expiresAt <= now) {
				challenges.delete(value);
			}
		}
		const challenge = randomBase64Url(32);
		challenges.set(challenge, { ...pending, expiresAt: now + TIMEOUT });
		return challenge;
	};

	/** Checks clientDataJSON and uses up its challenge, whether or not the rest of the verification passes. */
	const redeemChallenge = (
		clientDataJSON: string,
		type: PendingChallenge["type"],
	): PendingChallenge => {
		const clientData = parseJSON<ClientData>(
			new TextDecoder().decode(fromBase64Url(clientDataJSON)),
		);
		if (clientData?.type !== type) {
			throw verificationFailed(`Unexpected ceremony type: ${clientData?.type}`);
		}
		const pending = challenges.get(clientData.challenge);
		challenges.delete(clientData.challenge);
		if (pending?.type !== type) {
			throw verificationFailed(
				"The authenticator signed a challenge this page did not issue.",
			);
		}
		if (pending.expiresAt <= Date.now()) {
			throw new PasskeyError(
				"challenge_expired",
				"The challenge expired before the ceremony finished.",
			);
		}
		if (clientData.origin !== origin || clientData.crossOrigin) {
			throw verificationFailed(
				`The ceremony ran for ${clientData.origin}, not ${origin}.`,
			);
		}
		return pending;
	};

	/** Checks the RP ID hash and the user-present flag. */
	const checkAuthenticatorData = async (data: Uint8Array): Promise<void> => {
		const expectedRpIdHash = new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId)),
		);
		if (
			data.length < 37 ||
			!expectedRpIdHash.every((byte, index) => byte === data[index])
		) {
			throw verificationFailed(
				"The authenticator answered for a different relying party.",
			);
		}
		if ((data[32] & 0x01) === 0) {
			throw verificationFailed(
				"The authenticator did not report user presence.",
			);
		}
	};

	const signedInUserId = (): string | null =>
		sessionStorage.getItem(SESSION_KEY);

	const signIn = (user: User): User => {
		sessionStorage.setItem(SESSION_KEY, user.id);
		return toUser(user);
	};

	return {
		rpId,

		async registrationOptions({ userName, displayName }) {
			const name = userName.trim();
			if (!name) {
				throw new PasskeyError("invalid_username", "A username is required.");
			}
			const db = load();
			const existing = db.users.find((user) => sameName(user.name, name));
			// Only the signed-in owner of an account may add passkeys to it.
			if (existing && existing.id !== signedInUserId()) {
				throw new PasskeyError(
					"username_taken",
					`${name} is already registered.`,
				);
			}
			const user = existing
				? toUser(existing)
				: {
						id: randomBase64Url(32),
						name,
						displayName: displayName?.trim() || name,
					};
			return {
				rp: { id: rpId, name: rpName },
				user,
				challenge: issueChallenge({ type: "webauthn.create", user }),
				pubKeyCredParams: [
					{ type: "public-key", alg: ES256 },
					{ type: "public-key", alg: RS256 },
				],
				timeout: TIMEOUT,
				// An authenticator that already holds one of these refuses with InvalidStateError.
				excludeCredentials: db.credentials
					.filter((credential) => credential.userId === user.id)
					.map((credential) => ({
						type: "public-key",
						id: credential.id,
						transports: credential.transports,
					})),
				authenticatorSelection: {
					residentKey: "required",
					requireResidentKey: true,
					userVerification: "preferred",
				},
				attestation: "none",
			};
		},

		/**
		 * Trusts the public key the browser extracted from the attestation instead
		 * of parsing the CBOR attestation object; with `attestation: "none"` there
		 * is no attestation statement to check anyway.
		 */
		async verifyRegistration(credential: RegistrationResponseJSON) {
			const { user } = redeemChallenge(
				credential.response.clientDataJSON,
				"webauthn.create",
			);
			const { authenticatorData, publicKey, publicKeyAlgorithm, transports } =
				credential.response;
			if (!user || credential.id !== credential.rawId) {
				throw verificationFailed("The registration response is malformed.");
			}
			if (
				!authenticatorData ||
				!publicKey ||
				(publicKeyAlgorithm !== ES256 && publicKeyAlgorithm !== RS256)
			) {
				throw new PasskeyError(
					"unsupported_authenticator",
					"The browser did not expose an ES256 or RS256 public key.",
				);
			}
			await checkAuthenticatorData(fromBase64Url(authenticatorData));
			await importPublicKey(publicKey, publicKeyAlgorithm).catch(() => {
				throw new PasskeyError(
					"unsupported_authenticator",
					"The credential public key could not be imported.",
				);
			});

			const db = load();
			if (db.credentials.some(({ id }) => id === credential.id)) {
				throw verificationFailed("This passkey is already registered.");
			}
			if (
				db.users.some(
					({ id, name }) => id !== user.id && sameName(name, user.name),
				)
			) {
				throw new PasskeyError(
					"username_taken",
					`${user.name} was registered meanwhile.`,
				);
			}
			const now = Date.now();
			if (!db.users.some(({ id }) => id === user.id)) {
				db.users.push({ ...user, createdAt: now });
			}
			db.credentials.push({
				id: credential.id,
				userId: user.id,
				publicKey,
				algorithm: publicKeyAlgorithm,
				transports: transports ?? [],
				createdAt: now,
				lastUsedAt: null,
			});
			save(db);
			return signIn(user);
		},

		async authenticationOptions() {
			return {
				challenge: issueChallenge({ type: "webauthn.get" }),
				rpId,
				// Empty, so any discoverable passkey for this RP can answer — autofill needs that too.
				allowCredentials: [],
				userVerification: "preferred",
				timeout: TIMEOUT,
			};
		},

		async verifyAuthentication(credential: AuthenticationResponseJSON) {
			const { clientDataJSON, authenticatorData, signature, userHandle } =
				credential.response;
			redeemChallenge(clientDataJSON, "webauthn.get");

			const db = load();
			const stored = db.credentials.find(({ id }) => id === credential.id);
			const user = db.users.find(({ id }) => id === stored?.userId);
			if (!stored || !user) {
				throw new PasskeyError(
					"unknown_credential",
					`No account uses passkey ${credential.id}.`,
				);
			}
			if (!userHandle || (!user.legacy && userHandle !== user.id)) {
				throw verificationFailed(
					"The passkey's user handle does not match its account.",
				);
			}
			const authenticatorBytes = fromBase64Url(authenticatorData);
			await checkAuthenticatorData(authenticatorBytes);
			const verified = await verifySignature(
				stored,
				authenticatorBytes,
				fromBase64Url(clientDataJSON),
				fromBase64Url(signature),
			);
			if (!verified) {
				throw verificationFailed(
					"The assertion signature does not match the stored public key.",
				);
			}

			if (user.legacy) {
				for (const owned of db.credentials) {
					if (owned.userId === user.id) {
						owned.userId = userHandle;
					}
				}
				user.id = userHandle;
				user.legacy = undefined;
			}
			stored.lastUsedAt = Date.now();
			save(db);
			return signIn(user);
		},

		async currentUser() {
			const userId = signedInUserId();
			const user = userId
				? load().users.find(({ id }) => id === userId)
				: undefined;
			if (!user) {
				sessionStorage.removeItem(SESSION_KEY);
				return null;
			}
			return toUser(user);
		},

		async signOut() {
			sessionStorage.removeItem(SESSION_KEY);
		},

		async deleteAccount() {
			const userId = signedInUserId();
			if (!userId) {
				throw new PasskeyError("not_signed_in", "Nobody is signed in.");
			}
			const db = load();
			save({
				users: db.users.filter(({ id }) => id !== userId),
				credentials: db.credentials.filter(
					(credential) => credential.userId !== userId,
				),
			});
			sessionStorage.removeItem(SESSION_KEY);
		},
	};
};
