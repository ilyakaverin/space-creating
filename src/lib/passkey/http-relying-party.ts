/**
 * The relying party on the backend, reached with the JSON contract described
 * in docs/passkey-backend-requirements.md. The backend issues single-use
 * challenges, verifies credentials and keeps the session in an httpOnly
 * cookie, so this side never holds a secret.
 */
import { PasskeyError } from "./errors";
import type { RelyingParty, User } from "./types";

export interface HttpRelyingPartyOptions {
	/** Where the passkey API lives, e.g. "/api/passkey". */
	baseUrl: string;
	/** The backend's RP ID; only used for Signal API calls. Defaults to this page's hostname. */
	rpId?: string;
}

/**
 * A request still unanswered after this long is given up as a network
 * error, so the page shows a message instead of waiting forever. Generous:
 * a cold start on Vercel plus a sleeping Neon database takes a few seconds.
 */
const REQUEST_TIMEOUT_MS = 15_000;

interface ErrorBody {
	code?: string;
	message?: string;
}

export const createHttpRelyingParty = ({
	baseUrl,
	rpId = location.hostname,
}: HttpRelyingPartyOptions): RelyingParty => {
	const root = baseUrl.replace(/\/+$/, "");

	/**
	 * State-changing calls send JSON (POST) or use DELETE, which a cross-site
	 * form cannot forge without a CORS preflight; the backend must still reject
	 * other content types and check Origin.
	 */
	const request = async <T>(
		method: "GET" | "POST" | "DELETE",
		path: string,
		body?: unknown,
	): Promise<T> => {
		let response: Response;
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
		try {
			response = await fetch(`${root}${path}`, {
				method,
				credentials: "include",
				cache: "no-store",
				signal: abort.signal,
				headers:
					body === undefined
						? { Accept: "application/json" }
						: {
								Accept: "application/json",
								"Content-Type": "application/json",
							},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		} catch (cause) {
			clearTimeout(timer);
			throw new PasskeyError(
				"network_error",
				abort.signal.aborted
					? `${method} ${path} got no answer within ${REQUEST_TIMEOUT_MS / 1000} s.`
					: `${method} ${path} failed: ${String(cause)}`,
			);
		}
		// The body can stall too; the same timer still covers reading it.
		const payload: unknown =
			response.status === 204 ? null : await response.json().catch(() => null);
		clearTimeout(timer);
		if (!response.ok) {
			const { code, message } = (payload ?? {}) as ErrorBody;
			throw new PasskeyError(
				code ?? `http_${response.status}`,
				message ?? `${method} ${path} answered ${response.status}.`,
			);
		}
		if (payload === null && response.status !== 204) {
			throw new PasskeyError(
				"invalid_response",
				`${method} ${path} answered ${response.status} without a JSON body.`,
			);
		}
		return payload as T;
	};

	const userFrom = async (reply: Promise<{ user: User }>): Promise<User> =>
		(await reply).user;

	return {
		rpId,
		registrationOptions: (input) =>
			request("POST", "/registration/options", input),
		verifyRegistration: (credential) =>
			userFrom(request("POST", "/registration/verify", credential)),
		authenticationOptions: (input = {}) =>
			request("POST", "/authentication/options", input),
		verifyAuthentication: (credential) =>
			userFrom(request("POST", "/authentication/verify", credential)),
		currentUser: async () =>
			(await request<{ user: User | null }>("GET", "/session")).user,
		signOut: () => request("DELETE", "/session"),
	};
};
