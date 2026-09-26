/**
 * Error codes a relying party reports. A backend answers a failed request with
 * `{ "code": "...", "message": "..." }`; the message is for developers, the UI
 * shows its own text for the code.
 */
export type PasskeyErrorCode =
	| "invalid_username"
	| "username_taken"
	| "not_signed_in"
	| "challenge_expired"
	| "unknown_credential"
	| "verification_failed"
	| "unsupported_authenticator"
	| "network_error";

export class PasskeyError extends Error {
	readonly code: PasskeyErrorCode | (string & {});

	constructor(code: PasskeyErrorCode | (string & {}), message: string) {
		super(message);
		this.name = "PasskeyError";
		this.code = code;
	}
}

export type Ceremony = "registration" | "authentication" | "session";

const GENERIC = "Something went wrong with passkeys. Try again.";

/** A Map, so a code from the backend can never hit an Object.prototype key. */
const RELYING_PARTY_MESSAGES = new Map<string, string>([
	["invalid_username", "Enter a username to create a passkey."],
	["username_taken", "That username is taken. Pick another one."],
	["not_signed_in", "Your session has ended. Sign in again."],
	["challenge_expired", "The request expired. Try again."],
	["unknown_credential", "That passkey isn't registered here any more."],
	["verification_failed", "Your passkey couldn't be verified. Try again."],
	[
		"unsupported_authenticator",
		"This authenticator can't be used here. Try another one.",
	],
	["network_error", "Couldn't reach the server. Check your connection."],
] satisfies [PasskeyErrorCode, string][]);

/**
 * Raw error names and messages are for developers only. A warning, not an
 * error: these failures are expected (a cancelled prompt, a replaced autofill
 * request) and the UI already explains them, while Next.js's development
 * overlay reports every console.error as a bug in the app.
 */
export const logError = (cause: unknown, ceremony: Ceremony): void => {
	if (process.env.NODE_ENV === "development") {
		console.warn(`[passkey:${ceremony}]`, cause);
	}
};

/**
 * Maps a failure to the text the UI shows, or null for failures that must stay
 * silent — an `AbortError` is our own code cancelling a pending request.
 * Browsers deliberately report cancel, timeout, lost user activation and "no
 * matching passkey" all as `NotAllowedError`, so the message cannot tell them apart.
 */
export const describeError = (
	cause: unknown,
	ceremony: Ceremony,
): string | null => {
	logError(cause, ceremony);
	if (cause instanceof PasskeyError) {
		return RELYING_PARTY_MESSAGES.get(cause.code) ?? GENERIC;
	}
	if (!(cause instanceof DOMException)) {
		return GENERIC;
	}
	switch (cause.name) {
		case "AbortError":
			return null;
		case "NotAllowedError":
			return ceremony === "registration"
				? "Passkey creation was cancelled or didn't complete. Try again."
				: "Sign-in was cancelled or didn't complete. Try again.";
		case "InvalidStateError":
			return ceremony === "registration"
				? "This device already has a passkey for your account."
				: GENERIC;
		case "NotSupportedError":
			return "This device or browser can't use the kind of passkey this site asks for.";
		case "SecurityError":
			return "Passkeys can't be used on this address.";
		default:
			return GENERIC;
	}
};
