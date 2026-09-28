import { createHttpRelyingParty } from "./http-relying-party";
import type { RelyingParty } from "./types";

export * from "./errors";
export type * from "./types";
export * from "./webauthn";

/** Where the route handlers live: src/app/api/passkey. */
const API_PATH = "/api/passkey";

/**
 * The relying party: this site's backend, which verifies passkeys and keeps
 * accounts in Postgres. Browser-only — call it in an effect.
 *
 * NEXT_PUBLIC_PASSKEY_RP_ID is only needed when the backend's RP ID is a
 * parent domain of this page's hostname. Next.js writes its value into the
 * code at build time, so changing it needs a rebuild.
 */
export const createRelyingParty = (): RelyingParty =>
	createHttpRelyingParty({
		baseUrl: API_PATH,
		rpId: process.env.NEXT_PUBLIC_PASSKEY_RP_ID?.trim() || undefined,
	});
