/**
 * The two cookies — docs/passkey-backend-requirements.md §6.
 *
 * - session: who is signed in. HttpOnly, so page scripts cannot read it;
 *   SameSite=Lax, so other sites cannot make the browser send it with a POST.
 * - flow: ties challenges to one browser before anyone is signed in.
 *
 * With https origins the names get the `__Host-` prefix: browsers then refuse
 * the cookie unless it is Secure, has Path=/ and no Domain, so a subdomain can
 * neither read nor plant it. Over http://localhost that is impossible, so
 * development drops the prefix. The names say "passkey" because cookies are
 * not separated by port: a plain "session" would clash with other apps
 * running on localhost.
 */
import { randomBytes } from "node:crypto";
import type { cookies } from "next/headers";
import "server-only";
import type { PasskeyConfig } from "./config";
import type { NewSession } from "./sessions";

/**
 * What `await cookies()` returns inside a route handler: it reads the
 * request's cookies, and Next.js adds whatever is set on it to the response.
 */
export type CookieStore = Awaited<ReturnType<typeof cookies>>;

/** 16 random bytes in base64url. */
const FLOW_ID_FORMAT = /^[A-Za-z0-9_-]{22}$/;
/**
 * The flow cookie outlives its challenges: it is only a random ID, and it
 * must still be there when a late answer arrives, so the server can tell the
 * user the challenge expired instead of rejecting it as unknown.
 */
const FLOW_COOKIE_MAX_AGE_S = 24 * 60 * 60;

const names = ({ secureCookies }: PasskeyConfig) =>
	secureCookies
		? { session: "__Host-passkey-session", flow: "__Host-passkey-flow" }
		: { session: "passkey-session", flow: "passkey-flow" };

const sessionAttributes = (config: PasskeyConfig) =>
	({
		path: "/",
		httpOnly: true,
		secure: config.secureCookies,
		sameSite: "lax",
	}) as const;

export const readSessionToken = (
	cookies: CookieStore,
	config: PasskeyConfig,
): string | null => cookies.get(names(config).session)?.value ?? null;

export const setSessionCookie = (
	cookies: CookieStore,
	config: PasskeyConfig,
	session: NewSession,
): void => {
	cookies.set(names(config).session, session.token, {
		...sessionAttributes(config),
		expires: new Date(session.expiresAt),
	});
};

/** Same attributes as when set: browsers ignore a `__Host-` deletion without `Secure`. */
export const clearSessionCookie = (
	cookies: CookieStore,
	config: PasskeyConfig,
): void => {
	cookies.delete({ name: names(config).session, ...sessionAttributes(config) });
};

/**
 * For the options endpoints: reuses this browser's flow ID or starts one, and
 * renews the cookie's lifetime.
 */
export const ensureFlowId = (
	cookies: CookieStore,
	config: PasskeyConfig,
): string => {
	const existing = readFlowId(cookies, config);
	const flowId = existing ?? randomBytes(16).toString("base64url");
	cookies.set(names(config).flow, flowId, {
		path: "/",
		httpOnly: true,
		secure: config.secureCookies,
		// Only ever needed by our own fetches, never on navigation from elsewhere.
		sameSite: "strict",
		maxAge: FLOW_COOKIE_MAX_AGE_S,
	});
	return flowId;
};

/** For the verify endpoints: never creates one — no flow cookie, no challenge to redeem. */
export const readFlowId = (
	cookies: CookieStore,
	config: PasskeyConfig,
): string | null => {
	const value = cookies.get(names(config).flow)?.value;
	return value && FLOW_ID_FORMAT.test(value) ? value : null;
};
