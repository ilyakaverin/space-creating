/**
 * The HTTP layer shared by every route under /api/passkey —
 * docs/passkey-backend-requirements.md §3 and BR-SEC-2.
 *
 * `passkeyEndpoint` wraps a route handler so each route only has to read its
 * input, call a ceremony and shape the success response. The wrapper handles
 * everything common: the backend being off, the Origin check, turning errors
 * into `{ code, message }`, and the no-cache headers.
 */
import { dev } from "$app/environment";
import { type RequestEvent, type RequestHandler, json } from "@sveltejs/kit";
import type { PasskeyBackend } from "./backend";
import type { RequestContext } from "./ceremonies";
import type { PasskeyConfig } from "./config";
import { ApiError, type ErrorCode } from "./errors";
import { redact } from "./log";
import { passkeyBackend } from "./runtime";

/** The API's own body limit; adapter-node already refuses anything over BODY_SIZE_LIMIT (512 KB). */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * In production these codes answer with a coarse message; the precise failed
 * check only goes to the log (BR-ERR-5). Development shows it, to help debugging.
 */
const COARSE_MESSAGES: Partial<Record<ErrorCode, string>> = {
	verification_failed: "Credential could not be verified.",
};

export interface PasskeyRequest {
	event: RequestEvent;
	backend: PasskeyBackend;
	context: RequestContext;
}

/**
 * Browsers send an Origin header on every non-GET fetch, same-origin
 * included. Anything else did not come from our page (BR-SEC-2, FR-SEC-6).
 */
const checkOrigin = (request: Request, config: PasskeyConfig): void => {
	const origin = request.headers.get("origin");
	if (!origin || !config.origins.includes(origin)) {
		throw new ApiError(
			"forbidden_origin",
			`Origin ${origin ?? "(missing)"} is not allowed.`,
		);
	}
};

const toErrorResponse = (
	cause: unknown,
	requestId: string,
	path: string,
	backend: PasskeyBackend | null,
): Response => {
	if (cause instanceof ApiError) {
		backend?.log("request_rejected", {
			requestId,
			path,
			code: cause.code,
			reason: redact(cause.message),
		});
		const message = (!dev && COARSE_MESSAGES[cause.code]) || cause.message;
		return json(
			{ code: cause.code, message },
			{ status: cause.status, headers: cause.headers },
		);
	}
	// A bug or an outage: details go to the server log, the client gets an ID to quote.
	console.error(`[passkey] request ${requestId} failed:`, cause);
	return json(
		{
			code: "internal_error",
			message: `Internal error (request ${requestId}).`,
		},
		{ status: 500 },
	);
};

export const passkeyEndpoint =
	(handler: (request: PasskeyRequest) => Promise<Response>): RequestHandler =>
	async (event) => {
		const requestId = crypto.randomUUID();
		let backend: PasskeyBackend | null = null;
		let response: Response;
		try {
			backend = passkeyBackend();
			if (!backend) {
				throw new ApiError(
					"not_found",
					"The built-in passkey backend is off; set PUBLIC_PASSKEY_API_URL=/api/passkey to use it.",
				);
			}
			if (event.request.method !== "GET") {
				checkOrigin(event.request, backend.config);
			}
			response = await handler({
				event,
				backend,
				context: {
					user: event.locals.user,
					sessionTokenHash: event.locals.sessionTokenHash,
					flowId: null,
					clientAddress: event.getClientAddress(),
					userAgent: event.request.headers.get("user-agent"),
					requestId,
				},
			});
		} catch (cause) {
			response = toErrorResponse(cause, requestId, event.url.pathname, backend);
		}
		// Session answers must never be cached by the browser or a proxy (BR-GEN-3).
		response.headers.set("Cache-Control", "no-store");
		response.headers.set("X-Content-Type-Options", "nosniff");
		return response;
	};

/**
 * Reads a JSON body (BR-GEN-2). Requiring application/json is also CSRF
 * protection: a cross-site form cannot send it without a CORS preflight,
 * which this API never approves.
 */
export const readJson = async (request: Request): Promise<unknown> => {
	const mediaType = request.headers
		.get("content-type")
		?.split(";")[0]
		.trim()
		.toLowerCase();
	if (mediaType !== "application/json") {
		throw new ApiError(
			"unsupported_media_type",
			"Send the body as application/json.",
		);
	}
	if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
		throw new ApiError("payload_too_large", "The body is larger than 64 KiB.");
	}
	const bytes = await request.arrayBuffer();
	if (bytes.byteLength > MAX_BODY_BYTES) {
		throw new ApiError("payload_too_large", "The body is larger than 64 KiB.");
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new ApiError("invalid_request", "The body is not valid JSON.");
	}
};

/** DELETE endpoints answer exactly 204 without a body (BR-SES-5). */
export const noContent = (): Response => new Response(null, { status: 204 });
