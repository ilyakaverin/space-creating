/**
 * The WebAuthn ceremonies — docs/passkey-backend-requirements.md §4 and §7.
 *
 * Every ceremony has two halves:
 *   1. "start" hands the browser options containing a fresh challenge;
 *   2. "finish" receives what the authenticator signed and checks it.
 *
 * Functions here take the backend (config + stores), the request context
 * built by the route, and the untrusted JSON body. They return plain data:
 * cookies and HTTP responses are the route's job, so this file knows
 * nothing about SvelteKit.
 */
import {
	type PublicKeyCredentialCreationOptionsJSON,
	type PublicKeyCredentialRequestOptionsJSON,
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from "@simplewebauthn/server";
import {
	COSEALG,
	cose,
	decodeCredentialPublicKey,
	isoBase64URL,
} from "@simplewebauthn/server/helpers";
import type { User } from "./accounts";
import type { PasskeyBackend } from "./backend";
import { CEREMONY_TIMEOUT_MS } from "./challenges";
import { ApiError } from "./errors";
import { RATE_LIMITS } from "./rate-limit";
import type { NewSession } from "./sessions";
import {
	type ClientData,
	decodeClientData,
	isRecord,
	nameKey,
	parseAuthenticationResponse,
	parseDisplayName,
	parseRegistrationResponse,
	parseUserName,
} from "./validation";

/** What a route knows about the request, independent of HTTP details. */
export interface RequestContext {
	/** The signed-in user, resolved from the session cookie by hooks.server.ts. */
	user: User | null;
	sessionTokenHash: string | null;
	/** From the flow cookie that ties challenges to this browser; null if absent. */
	flowId: string | null;
	/**
	 * The client's IP address. A function because adapter-node throws when
	 * ADDRESS_HEADER is configured but missing from a request; only the
	 * rate-limited ceremonies need it, so the other endpoints keep working.
	 */
	clientAddress(): string;
	userAgent: string | null;
	requestId: string;
}

/** Who made the request, for every security log entry (BR-SEC-8). */
export const requestFields = (context: RequestContext) => {
	let ip: string | null = null;
	try {
		ip = context.clientAddress();
	} catch {
		// Logged without an address rather than not at all.
	}
	return { requestId: context.requestId, ip, userAgent: context.userAgent };
};

/** Options endpoints always have a flow ID: they create the cookie if needed. */
type WithFlow = RequestContext & { flowId: string };

export interface SignedIn {
	user: User;
	session: NewSession;
}

/**
 * Algorithms offered at registration (BR-WA-7): EdDSA, ES256 (what almost
 * every passkey uses) and RS256 (Windows Hello on older machines).
 */
export const ALLOWED_ALGORITHMS: number[] = [
	COSEALG.EdDSA,
	COSEALG.ES256,
	COSEALG.RS256,
];

/**
 * Everything the library knows how to handle. It gets this wider list so an
 * authenticator outside our policy fails our own check below with a clear
 * `unsupported_authenticator`, not a generic library error.
 */
const LIBRARY_ALGORITHMS = Object.values(COSEALG).filter(
	(value): value is COSEALG => typeof value === "number",
);

/** WebAuthn caps credential IDs at 1023 bytes (BR-WA-6). */
const MAX_CREDENTIAL_ID_BYTES = 1023;

const randomBytes32 = () => crypto.getRandomValues(new Uint8Array(32));

const verificationFailed = (reason: unknown) =>
	new ApiError(
		"verification_failed",
		reason instanceof Error ? reason.message : String(reason),
	);

/**
 * The site is never embedded in another site's iframe, so a ceremony run in
 * a cross-origin frame is always suspicious. The library does not reject it
 * for registrations, nor for sign-ins without `topOrigin` (BR-WA-3).
 */
const rejectCrossOrigin = (clientData: ClientData): void => {
	if (clientData.crossOrigin || clientData.topOrigin) {
		throw new ApiError(
			"verification_failed",
			"The ceremony ran inside a cross-origin frame.",
		);
	}
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * POST /registration/options (BR-REGO). Signed out it prepares a new
 * account; signed in it adds a passkey to the current one (FR-OPT-2).
 */
export const startRegistration = async (
	{ accounts, challenges, config, limiter }: PasskeyBackend,
	context: WithFlow,
	body: unknown,
): Promise<PublicKeyCredentialCreationOptionsJSON> => {
	limiter.consume(`options:${context.clientAddress()}`, RATE_LIMITS.options);
	if (!isRecord(body)) {
		throw new ApiError(
			"invalid_request",
			"Expected { userName, displayName? }.",
		);
	}
	const userName = parseUserName(body.userName);

	let user: User;
	if (context.user) {
		// Adding a passkey: the options are always for the signed-in account (BR-REGO-5).
		if (nameKey(context.user.name) !== userName.key) {
			throw new ApiError(
				"invalid_username",
				"While signed in, passkeys can only be added to your own account.",
			);
		}
		user = context.user;
	} else {
		// A new account. A taken name is refused now, before any
		// authenticator prompt opens (FR-ERR-2, BR-REGO-4).
		if (accounts.findUserByName(userName.name)) {
			throw new ApiError(
				"username_taken",
				`${userName.name} is already registered.`,
			);
		}
		user = {
			// The user handle is random, never derived from the name (BR-REGO-6).
			id: isoBase64URL.fromBuffer(randomBytes32()),
			name: userName.name,
			displayName: parseDisplayName(body.displayName, userName.name),
		};
	}

	const options = await generateRegistrationOptions({
		rpName: config.rpName,
		rpID: config.rpId,
		userID: isoBase64URL.toBuffer(user.id),
		userName: user.name,
		userDisplayName: user.displayName,
		// Bytes, not a string: the library would UTF-8-encode a string first.
		challenge: randomBytes32(),
		timeout: CEREMONY_TIMEOUT_MS,
		attestationType: "none",
		// An authenticator that already holds one of these refuses with
		// InvalidStateError instead of creating a duplicate passkey.
		excludeCredentials: accounts.listCredentials(user.id),
		// Discoverable passkeys ("resident keys") are what sign-in without a
		// username and autofill need. No authenticatorAttachment, so phones and
		// security keys stay possible (FR-OPT-3). A fresh object each time: the
		// library modifies it.
		authenticatorSelection: {
			residentKey: "required",
			userVerification: "preferred",
		},
		supportedAlgorithmIDs: ALLOWED_ALGORITHMS,
	});

	challenges.issue({
		challenge: options.challenge,
		flowId: context.flowId,
		type: "registration",
		// A new account only exists in the challenge until verification succeeds.
		pendingUser: context.user ? null : user,
		sessionUserId: context.user?.id ?? null,
	});
	return options;
};

/** POST /registration/verify (BR-REGV). Stores the passkey and signs its user in. */
export const finishRegistration = async (
	{ accounts, challenges, config, db, limiter, log, sessions }: PasskeyBackend,
	context: RequestContext,
	body: unknown,
): Promise<SignedIn> => {
	limiter.consume(`verify:${context.clientAddress()}`, RATE_LIMITS.verify);
	const response = parseRegistrationResponse(body);
	const clientData = decodeClientData(response.response.clientDataJSON);

	// Used up first, before any other check: a replay or a failed attempt can never reuse it.
	const challenge = challenges.redeem({
		challenge: clientData.challenge,
		flowId: context.flowId,
		type: "registration",
	});
	rejectCrossOrigin(clientData);

	// Adding a passkey: the session that asked for the options must still be
	// the one signed in (BR-REGV-3).
	let user: User | null = challenge.pendingUser;
	if (challenge.sessionUserId) {
		if (context.user?.id !== challenge.sessionUserId) {
			throw new ApiError(
				"not_signed_in",
				"The session that started this registration has ended.",
			);
		}
		user = context.user;
	}
	if (!user) {
		throw new ApiError(
			"verification_failed",
			"The challenge names no account.",
		);
	}

	// The library checks type, challenge, origin, RP ID hash, user presence,
	// backup flags and the attestation statement (BR-WA-1…10).
	let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
	try {
		verification = await verifyRegistrationResponse({
			response,
			expectedChallenge: challenge.challenge,
			expectedOrigin: config.origins,
			expectedRPID: config.rpId,
			// The options only *prefer* user verification, so it cannot be demanded
			// here; the library would otherwise require it (BR-WA-5).
			requireUserVerification: false,
			supportedAlgorithmIDs: LIBRARY_ALGORITHMS,
		});
	} catch (reason) {
		throw verificationFailed(reason);
	}
	if (!verification.verified) {
		throw verificationFailed("The attestation statement did not verify.");
	}
	const info = verification.registrationInfo;

	// What the library leaves to us: the ID inside the signed authenticator
	// data must be the one the request claims, and within the size limit.
	if (info.credential.id !== response.id) {
		throw verificationFailed(
			"The credential ID in authenticatorData differs from id.",
		);
	}
	if (
		isoBase64URL.toBuffer(info.credential.id).length > MAX_CREDENTIAL_ID_BYTES
	) {
		throw verificationFailed("The credential ID is longer than 1023 bytes.");
	}
	const algorithm = decodeCredentialPublicKey(info.credential.publicKey).get(
		cose.COSEKEYS.alg,
	);
	if (
		typeof algorithm !== "number" ||
		!ALLOWED_ALGORITHMS.includes(algorithm)
	) {
		throw new ApiError(
			"unsupported_authenticator",
			`Public key algorithm ${algorithm} is not accepted.`,
		);
	}

	// All-or-nothing: account, passkey and session appear together or not at all.
	const newAccount = !challenge.sessionUserId;
	const signedInUser = user;
	const session = db.transaction(() => {
		if (newAccount) {
			accounts.createUser(signedInUser);
		}
		accounts.addCredential({
			id: info.credential.id,
			userId: signedInUser.id,
			publicKey: info.credential.publicKey,
			algorithm,
			counter: info.credential.counter,
			transports: response.response.transports ?? [],
			aaguid: info.aaguid,
			backupEligible: info.credentialDeviceType === "multiDevice",
			backedUp: info.credentialBackedUp,
		});
		// A new session on every sign-in; the old one is dropped (BR-COOK-4).
		if (context.sessionTokenHash) {
			sessions.revoke(context.sessionTokenHash);
		}
		return sessions.create(signedInUser.id, context.userAgent);
	})();

	log("registration", {
		...requestFields(context),
		userId: signedInUser.id,
		credentialId: info.credential.id,
		newAccount,
		userVerified: info.userVerified,
	});
	return { user: signedInUser, session };
};

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/** POST /authentication/options (BR-AUTHO). Identical for everyone: reveals no accounts. */
export const startAuthentication = async (
	{ challenges, config, limiter }: PasskeyBackend,
	context: WithFlow,
): Promise<PublicKeyCredentialRequestOptionsJSON> => {
	limiter.consume(`options:${context.clientAddress()}`, RATE_LIMITS.options);
	const options = await generateAuthenticationOptions({
		rpID: config.rpId,
		challenge: randomBytes32(),
		timeout: CEREMONY_TIMEOUT_MS,
		userVerification: "preferred",
		// Empty: any discoverable passkey for this site may answer, which both
		// the sign-in button and username autofill rely on.
		allowCredentials: [],
	});
	challenges.issue({
		challenge: options.challenge,
		flowId: context.flowId,
		type: "authentication",
	});
	return options;
};

/** POST /authentication/verify (BR-AUTHV). Checks the assertion and signs its user in. */
export const finishAuthentication = async (
	{ accounts, challenges, config, db, limiter, log, sessions }: PasskeyBackend,
	context: RequestContext,
	body: unknown,
): Promise<SignedIn> => {
	limiter.consume(`verify:${context.clientAddress()}`, RATE_LIMITS.verify);
	const response = parseAuthenticationResponse(body);
	const clientData = decodeClientData(response.response.clientDataJSON);
	// Used up first, before any other check: a replay or a failed attempt can never reuse it.
	challenges.redeem({
		challenge: clientData.challenge,
		flowId: context.flowId,
		type: "authentication",
	});
	rejectCrossOrigin(clientData);

	// Only here may unknown_credential be answered: the frontend then asks the
	// password manager to hide this passkey (BR-ERR-3).
	const stored = accounts.findCredential(response.id);
	const owner = stored ? accounts.findUser(stored.userId) : null;
	if (!stored || !owner) {
		log("unknown_credential", {
			...requestFields(context),
			credentialId: response.id,
		});
		throw new ApiError("unknown_credential", "No account uses this passkey.");
	}

	// allowCredentials was empty, so the authenticator chose the passkey and
	// must say whose it is. The library does not compare this (BR-AUTHV-4).
	if (response.response.userHandle !== owner.id) {
		throw verificationFailed(
			"The user handle does not match the passkey's account.",
		);
	}

	// The library checks type, challenge, origin, RP ID hash, user presence and
	// the signature against the stored public key (BR-WA-11…14).
	let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
	try {
		verification = await verifyAuthenticationResponse({
			response,
			expectedChallenge: clientData.challenge,
			expectedOrigin: config.origins,
			expectedRPID: config.rpId,
			credential: {
				id: stored.id,
				publicKey: new Uint8Array(stored.publicKey),
				// 0 turns off the library's own counter check. The counter is compared
				// below instead: only after the signature has proven the response is
				// genuine, and atomically, so concurrent sign-ins cannot lower it.
				counter: 0,
				transports: stored.transports,
			},
			requireUserVerification: false,
		});
	} catch (reason) {
		throw verificationFailed(reason);
	}
	if (!verification.verified) {
		throw verificationFailed("The signature did not verify.");
	}
	const info = verification.authenticationInfo;

	// Whether a passkey *can* sync is fixed at creation; only whether it *is*
	// synced may change (BR-WA-16).
	if ((info.credentialDeviceType === "multiDevice") !== stored.backupEligible) {
		throw verificationFailed("The backup-eligible flag changed.");
	}

	const session = db.transaction(() => {
		const counterAdvanced = accounts.recordSignIn(stored.id, {
			counter: info.newCounter,
			backedUp: info.credentialBackedUp,
		});
		// A genuine signature with a counter that did not grow suggests a cloned
		// authenticator (BR-WA-15). Throwing rolls the transaction back.
		if (!counterAdvanced) {
			log("counter_regression", {
				...requestFields(context),
				userId: owner.id,
				credentialId: stored.id,
				received: info.newCounter,
			});
			throw verificationFailed("The signature counter did not increase.");
		}
		if (context.sessionTokenHash) {
			sessions.revoke(context.sessionTokenHash);
		}
		return sessions.create(owner.id, context.userAgent);
	})();

	log("sign_in", {
		...requestFields(context),
		userId: owner.id,
		credentialId: stored.id,
		userVerified: info.userVerified,
	});
	return { user: owner, session };
};

// ---------------------------------------------------------------------------
// Session and account
// ---------------------------------------------------------------------------

/** DELETE /session (BR-SES-4). Idempotent: signing out twice is fine. */
export const signOut = (
	{ log, sessions }: PasskeyBackend,
	context: RequestContext,
): void => {
	if (context.sessionTokenHash) {
		sessions.revoke(context.sessionTokenHash);
		log("sign_out", { ...requestFields(context), userId: context.user?.id });
	}
};

/**
 * DELETE /account (BR-ACC). Deleting the user row cascades to their
 * passkeys, every session on every device and pending challenges.
 */
export const deleteAccount = (
	{ accounts, log }: PasskeyBackend,
	context: RequestContext,
): void => {
	if (!context.user) {
		throw new ApiError("not_signed_in", "Sign in to delete your account.");
	}
	accounts.deleteUser(context.user.id);
	log("account_deleted", {
		...requestFields(context),
		userId: context.user.id,
	});
};
