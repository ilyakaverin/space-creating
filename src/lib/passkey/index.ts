import { createHttpRelyingParty } from "./http-relying-party";
import { createLocalRelyingParty } from "./local-relying-party";
import type { RelyingParty } from "./types";

export * from "./errors";
export type * from "./types";
export * from "./webauthn";

const RP_NAME = "creating space";

/**
 * Picks where passkeys are verified and stored: in this browser by default, or
 * on the backend at NEXT_PUBLIC_PASSKEY_API_URL. Both speak the same JSON
 * contract, so the UI does not change. Browser-only — call it in an effect.
 *
 * Next.js replaces each `process.env.NEXT_PUBLIC_…` expression with its value
 * at build time, so changing them needs a rebuild.
 */
export const createRelyingParty = (): RelyingParty => {
	const apiUrl = process.env.NEXT_PUBLIC_PASSKEY_API_URL?.trim();
	return apiUrl
		? createHttpRelyingParty({
				baseUrl: apiUrl,
				rpId: process.env.NEXT_PUBLIC_PASSKEY_RP_ID?.trim() || undefined,
			})
		: createLocalRelyingParty({ rpName: RP_NAME });
};
