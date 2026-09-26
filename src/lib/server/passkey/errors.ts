/**
 * API errors — docs/passkey-backend-requirements.md §3.1.
 *
 * Code anywhere in the backend throws an `ApiError`; the endpoint wrapper in
 * `http.ts` turns it into `{ "code", "message" }` with the matching status.
 * The frontend picks its user-facing text from `code`; `message` is only for
 * developers.
 */

export type ErrorCode =
	| "invalid_request"
	| "invalid_username"
	| "verification_failed"
	| "challenge_expired"
	| "not_signed_in"
	| "forbidden_origin"
	| "unknown_credential"
	| "not_found"
	| "username_taken"
	| "payload_too_large"
	| "unsupported_media_type"
	| "unsupported_authenticator"
	| "rate_limited"
	| "internal_error";

const STATUS: Record<ErrorCode, number> = {
	invalid_request: 400,
	invalid_username: 400,
	verification_failed: 400,
	challenge_expired: 400,
	not_signed_in: 401,
	forbidden_origin: 403,
	// Reserved for "this credential ID is not stored": the frontend then asks the
	// password manager to hide the passkey, so nothing else may use it (BR-ERR-3).
	unknown_credential: 404,
	// The built-in backend is switched off (see runtime.ts).
	not_found: 404,
	username_taken: 409,
	payload_too_large: 413,
	unsupported_media_type: 415,
	unsupported_authenticator: 422,
	rate_limited: 429,
	internal_error: 500,
};

export class ApiError extends Error {
	readonly code: ErrorCode;
	readonly status: number;
	/** Extra response headers, e.g. `Retry-After` for rate limiting. */
	readonly headers: Record<string, string>;

	constructor(
		code: ErrorCode,
		message: string,
		headers: Record<string, string> = {},
	) {
		super(message);
		this.name = "ApiError";
		this.code = code;
		this.status = STATUS[code];
		this.headers = headers;
	}
}
