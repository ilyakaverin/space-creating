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
 * development uses plain names.
 */
import { randomBytes } from "node:crypto";
import type { Cookies } from "@sveltejs/kit";
import { CHALLENGE_TTL_MS } from "./challenges";
import type { PasskeyConfig } from "./config";
import type { NewSession } from "./sessions";

/** 16 random bytes in base64url. */
const FLOW_ID_FORMAT = /^[A-Za-z0-9_-]{22}$/;

const names = ({ secureCookies }: PasskeyConfig) =>
	secureCookies
		? { session: "__Host-session", flow: "__Host-passkey-flow" }
		: { session: "session", flow: "passkey-flow" };

const sessionAttributes = (config: PasskeyConfig) =>
	({
		path: "/",
		httpOnly: true,
		secure: config.secureCookies,
		sameSite: "lax",
	}) as const;

export const readSessionToken = (
	cookies: Cookies,
	config: PasskeyConfig,
): string | null => cookies.get(names(config).session) ?? null;

export const setSessionCookie = (
	cookies: Cookies,
	config: PasskeyConfig,
	session: NewSession,
): void => {
	cookies.set(names(config).session, session.token, {
		...sessionAttributes(config),
		expires: new Date(session.expiresAt),
	});
};

export const clearSessionCookie = (
	cookies: Cookies,
	config: PasskeyConfig,
): void => {
	cookies.delete(names(config).session, sessionAttributes(config));
};

/**
 * For the options endpoints: reuses this browser's flow ID or starts one, and
 * keeps the cookie alive exactly as long as the newest challenge.
 */
export const useFlowId = (cookies: Cookies, config: PasskeyConfig): string => {
	const existing = readFlowId(cookies, config);
	const flowId = existing ?? randomBytes(16).toString("base64url");
	cookies.set(names(config).flow, flowId, {
		path: "/",
		httpOnly: true,
		secure: config.secureCookies,
		// Only ever needed by our own fetches, never on navigation from elsewhere.
		sameSite: "strict",
		maxAge: CHALLENGE_TTL_MS / 1000,
	});
	return flowId;
};

/** For the verify endpoints: never creates one — no flow cookie, no challenge to redeem. */
export const readFlowId = (
	cookies: Cookies,
	config: PasskeyConfig,
): string | null => {
	const value = cookies.get(names(config).flow);
	return value && FLOW_ID_FORMAT.test(value) ? value : null;
};
