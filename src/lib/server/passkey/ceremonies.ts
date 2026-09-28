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
 * nothing about Next.js.
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
	parseAuthenticationResponse,
	parseRegistrationResponse,
	parseUserName,
} from "./validation";

/** What a route knows about the request, independent of HTTP details. */
export interface RequestContext {
	/** The signed-in user, resolved from the session cookie by `http.ts`. */
	user: User | null;
	sessionTokenHash: string | null;
	/** From the flow cookie that ties challenges to this browser; null if absent. */
	flowId: string | null;
	/**
	 * The client's IP address. A function because it throws when the
	 * configured header is missing from a request; only the rate-limited
	 * ceremonies need it, so the other endpoints keep working.
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
 * POST /registration/options (BR-REGO). Every registration creates a new
 * account under the username typed; the account only exists with the
 * challenge until the passkey is verified (BR-REGO-4).
 *
 * A username has one account, and an account one passkey — there is no
 * "add a passkey" — so a device can never get a second passkey for the
 * same account.
 */
export const startRegistration = async (
	{ accounts, challenges, config, limiter }: PasskeyBackend,
	context: WithFlow,
	body: unknown,
): Promise<PublicKeyCredentialCreationOptionsJSON> => {
	await limiter.consume(
		`options:${context.clientAddress()}`,
		RATE_LIMITS.options,
	);
	if (!isRecord(body)) {
		throw new ApiError("invalid_request", "Expected { userName }.");
	}
	const { name } = parseUserName(body.userName);
	// Refused now, before any authenticator prompt opens (BR-REGO-3).
	if (await accounts.findUserByName(name)) {
		throw new ApiError("username_taken", `${name} is already registered.`);
	}
	const user: User = {
		// The user handle is random, never derived from the name (BR-REGO-6).
		id: isoBase64URL.fromBuffer(randomBytes32()),
		name,
	};

	const options = await generateRegistrationOptions({
		rpName: config.rpName,
		rpID: config.rpId,
		userID: isoBase64URL.toBuffer(user.id),
		userName: user.name,
		userDisplayName: user.name,
		// Bytes, not a string: the library would UTF-8-encode a string first.
		challenge: randomBytes32(),
		timeout: CEREMONY_TIMEOUT_MS,
		attestationType: "none",
		// No excludeCredentials: the account is new, so it has no passkeys yet.
		// Discoverable passkeys ("resident keys") store the user handle on the
		// authenticator, which is what lets sign-in work without a username.
		// No authenticatorAttachment, so phones and security keys stay possible
		// (FR-OPT-3). A fresh object each time: the library modifies it.
		authenticatorSelection: {
			residentKey: "required",
			userVerification: "preferred",
		},
		supportedAlgorithmIDs: ALLOWED_ALGORITHMS,
	});

	await challenges.issue({
		challenge: options.challenge,
		flowId: context.flowId,
		type: "registration",
		pendingUser: user,
	});
	return options;
};

/** POST /registration/verify (BR-REGV). Stores the passkey and signs its user in. */
export const finishRegistration = async (
	{ challenges, config, limiter, log, transaction }: PasskeyBackend,
	context: RequestContext,
	body: unknown,
): Promise<SignedIn> => {
	await limiter.consume(
		`verify:${context.clientAddress()}`,
		RATE_LIMITS.verify,
	);
	const response = parseRegistrationResponse(body);
	const clientData = decodeClientData(response.response.clientDataJSON);

	// Used up first, before any other check: a replay or a failed attempt can never reuse it.
	const challenge = await challenges.redeem({
		challenge: clientData.challenge,
		flowId: context.flowId,
		type: "registration",
	});
	rejectCrossOrigin(clientData);

	const user = challenge.pendingUser;
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
	const session = await transaction(async ({ accounts, sessions }) => {
		await accounts.createUser(user);
		await accounts.addCredential({
			id: info.credential.id,
			userId: user.id,
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
			await sessions.revoke(context.sessionTokenHash);
		}
		return sessions.create(user.id, context.userAgent);
	});

	log("registration", {
		...requestFields(context),
		userId: user.id,
		credentialId: info.credential.id,
		userVerified: info.userVerified,
	});
	return { user, session };
};

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * POST /authentication/options (BR-AUTHO). `{ userName }` limits the sign-in
 * to that account's passkeys; `{}` lets any passkey this device holds for
 * the site answer.
 */
export const startAuthentication = async (
	{ accounts, challenges, config, limiter }: PasskeyBackend,
	context: WithFlow,
	body: unknown,
): Promise<PublicKeyCredentialRequestOptionsJSON> => {
	await limiter.consume(
		`options:${context.clientAddress()}`,
		RATE_LIMITS.options,
	);
	if (!isRecord(body)) {
		throw new ApiError("invalid_request", "Expected { userName? }.");
	}
	let user: User | null = null;
	if (body.userName !== undefined) {
		const { name } = parseUserName(body.userName);
		user = await accounts.findUserByName(name);
		// Says no more than registration's username_taken does (BR-SEC-6).
		if (!user) {
			throw new ApiError("unknown_user", `No account is named ${name}.`);
		}
	}
	const options = await generateAuthenticationOptions({
		rpID: config.rpId,
		challenge: randomBytes32(),
		timeout: CEREMONY_TIMEOUT_MS,
		userVerification: "preferred",
		// With a username, the browser offers only that account's passkeys.
		// Without, the list is empty: any discoverable passkey for this site
		// may answer, and the passkey itself says whose it is.
		allowCredentials: user ? await accounts.listCredentials(user.id) : [],
	});
	await challenges.issue({
		challenge: options.challenge,
		flowId: context.flowId,
		type: "authentication",
		userId: user?.id ?? null,
	});
	return options;
};

/** POST /authentication/verify (BR-AUTHV). Checks the assertion and signs its user in. */
export const finishAuthentication = async (
	{ accounts, challenges, config, limiter, log, transaction }: PasskeyBackend,
	context: RequestContext,
	body: unknown,
): Promise<SignedIn> => {
	await limiter.consume(
		`verify:${context.clientAddress()}`,
		RATE_LIMITS.verify,
	);
	const response = parseAuthenticationResponse(body);
	const clientData = decodeClientData(response.response.clientDataJSON);
	// Used up first, before any other check: a replay or a failed attempt can never reuse it.
	const challenge = await challenges.redeem({
		challenge: clientData.challenge,
		flowId: context.flowId,
		type: "authentication",
	});
	rejectCrossOrigin(clientData);

	// Only here may unknown_credential be answered: the frontend then asks the
	// password manager to hide this passkey (BR-ERR-3).
	const stored = await accounts.findCredential(response.id);
	const owner = stored ? await accounts.findUser(stored.userId) : null;
	if (!stored || !owner) {
		log("unknown_credential", {
			...requestFields(context),
			credentialId: response.id,
		});
		throw new ApiError("unknown_credential", "No account uses this passkey.");
	}

	// The authenticator may have chosen the passkey itself, so it must say
	// whose it is. The library does not compare this (BR-AUTHV-4).
	if (response.response.userHandle !== owner.id) {
		throw verificationFailed(
			"The user handle does not match the passkey's account.",
		);
	}
	// A username was typed: the passkey must be that account's, whatever a
	// modified client sent instead of what allowCredentials offered (BR-AUTHV-8).
	if (challenge.userId && challenge.userId !== owner.id) {
		throw verificationFailed(
			"The passkey belongs to another account than the username typed.",
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

	const session = await transaction(async ({ accounts, sessions }) => {
		const counterAdvanced = await accounts.recordSignIn(stored.id, {
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
			await sessions.revoke(context.sessionTokenHash);
		}
		return sessions.create(owner.id, context.userAgent);
	});

	log("sign_in", {
		...requestFields(context),
		userId: owner.id,
		credentialId: stored.id,
		userVerified: info.userVerified,
	});
	return { user: owner, session };
};

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** DELETE /session (BR-SES-4). Idempotent: signing out twice is fine. */
export const signOut = async (
	{ log, sessions }: PasskeyBackend,
	context: RequestContext,
): Promise<void> => {
	if (context.sessionTokenHash) {
		await sessions.revoke(context.sessionTokenHash);
		log("sign_out", { ...requestFields(context), userId: context.user?.id });
	}
};
