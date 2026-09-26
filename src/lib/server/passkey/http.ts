/**
 * The HTTP layer shared by every route under /api/passkey —
 * docs/passkey-backend-requirements.md §3 and BR-SEC-2.
 *
 * `passkeyEndpoint` wraps a Next.js route handler so each route only has to
 * read its input, call a ceremony and shape the success response. The
 * wrapper handles everything common: the backend being off, the Origin
 * check, the session cookie, turning errors into `{ code, message }`, and
 * the no-cache headers.
 */
import { cookies } from "next/headers";
import "server-only";
import type { PasskeyBackend } from "./backend";
import { type RequestContext, requestFields } from "./ceremonies";
import type { PasskeyConfig } from "./config";
import {
	type CookieStore,
	clearSessionCookie,
	readSessionToken,
	setSessionCookie,
} from "./cookies";
import { ApiError, type ErrorCode } from "./errors";
import { redact } from "./log";
import { passkeyBackend } from "./runtime";

/** Next.js puts no size limit on route handler bodies, so the API sets its own. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * In production these codes answer with a coarse message; the precise failed
 * check only goes to the log (BR-ERR-5). Development shows it, to help debugging.
 */
const COARSE_MESSAGES: Partial<Record<ErrorCode, string>> = {
	verification_failed: "Credential could not be verified.",
};

export interface PasskeyRequest {
	request: Request;
	cookies: CookieStore;
	backend: PasskeyBackend;
	context: RequestContext;
}

/** Reading methods never change state, so they need no Origin check. */
const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * Browsers send an Origin header on every POST and DELETE fetch, same-origin
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

/**
 * Route handlers never see the TCP connection, so the client's address comes
 * from a header. Next.js fills in X-Forwarded-For with the connection's
 * address only when the request has none, so without a reverse proxy a
 * client can pick its own. Behind proxies that each append to it, the entry
 * `xffDepth` places from the right is the one the outermost proxy saw.
 */
const clientAddressOf = (headers: Headers, config: PasskeyConfig): string => {
	const { clientIpHeader, xffDepth } = config;
	const value = headers.get(clientIpHeader)?.trim();
	if (!value) {
		throw new Error(
			`The ${clientIpHeader} header is missing, so the client address is unknown (see PASSKEY_CLIENT_IP_HEADER).`,
		);
	}
	if (clientIpHeader !== "x-forwarded-for") {
		return value;
	}
	const hops = value.split(",").map((entry) => entry.trim());
	const address = hops[hops.length - xffDepth];
	if (!address) {
		throw new Error(
			`X-Forwarded-For has ${hops.length} entries, fewer than PASSKEY_XFF_DEPTH=${xffDepth}.`,
		);
	}
	return address;
};

/**
 * Turns the session cookie into the signed-in user (BR-COOK-6). An unknown
 * or expired cookie is deleted; a session past half its lifetime gets a
 * fresh expiry and cookie (sliding expiry).
 */
const resolveSession = (
	cookies: CookieStore,
	backend: PasskeyBackend,
): Pick<RequestContext, "user" | "sessionTokenHash"> => {
	const signedOut = { user: null, sessionTokenHash: null };
	const token = readSessionToken(cookies, backend.config);
	if (!token) {
		return signedOut;
	}
	const session = backend.sessions.validate(token);
	if (!session) {
		clearSessionCookie(cookies, backend.config);
		return signedOut;
	}
	if (session.refreshed) {
		setSessionCookie(cookies, backend.config, {
			token,
			expiresAt: session.expiresAt,
		});
	}
	return { user: session.user, sessionTokenHash: session.tokenHash };
};

const toErrorResponse = (
	cause: unknown,
	context: RequestContext,
	path: string,
	backend: PasskeyBackend | null,
): Response => {
	const { requestId } = context;
	if (cause instanceof ApiError) {
		backend?.log("request_rejected", {
			...requestFields(context),
			path,
			code: cause.code,
			reason: redact(cause.message),
		});
		const message =
			(process.env.NODE_ENV !== "development" && COARSE_MESSAGES[cause.code]) ||
			cause.message;
		return Response.json(
			{ code: cause.code, message },
			{ status: cause.status, headers: cause.headers },
		);
	}
	// A bug or an outage: details go to the server log, the client gets an ID to quote.
	console.error(`[passkey] request ${requestId} failed:`, cause);
	return Response.json(
		{
			code: "internal_error",
			message: `Internal error (request ${requestId}).`,
		},
		{ status: 500 },
	);
};

export const passkeyEndpoint =
	(handler: (request: PasskeyRequest) => Promise<Response>) =>
	async (request: Request): Promise<Response> => {
		const context: RequestContext = {
			user: null,
			sessionTokenHash: null,
			flowId: null,
			clientAddress: () => {
				throw new Error("The passkey backend is not running.");
			},
			userAgent: request.headers.get("user-agent"),
			requestId: crypto.randomUUID(),
		};
		let backend: PasskeyBackend | null = null;
		let response: Response;
		try {
			backend = passkeyBackend();
			if (!backend) {
				throw new ApiError(
					"not_found",
					"The built-in passkey backend is off; set NEXT_PUBLIC_PASSKEY_API_URL=/api/passkey to use it.",
				);
			}
			const { config } = backend;
			context.clientAddress = () => clientAddressOf(request.headers, config);
			if (!SAFE_METHODS.has(request.method)) {
				checkOrigin(request, config);
			}
			const cookieStore = await cookies();
			Object.assign(context, resolveSession(cookieStore, backend));
			response = await handler({
				request,
				cookies: cookieStore,
				backend,
				context,
			});
		} catch (cause) {
			const path = new URL(request.url).pathname;
			response = toErrorResponse(cause, context, path, backend);
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
	const tooLarge = () =>
		new ApiError("payload_too_large", "The body is larger than 64 KiB.");
	if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
		throw tooLarge();
	}
	// Content-Length may be absent (chunked upload) or wrong, so count while
	// reading and stop at the limit instead of buffering whatever arrives.
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (request.body) {
		const reader = request.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			size += value.byteLength;
			if (size > MAX_BODY_BYTES) {
				await reader.cancel();
				throw tooLarge();
			}
			chunks.push(value);
		}
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new ApiError("invalid_request", "The body is not valid JSON.");
	}
};

/** DELETE endpoints answer exactly 204 without a body (BR-SES-5). */
export const noContent = (): Response => new Response(null, { status: 204 });
