import { env } from "$env/dynamic/public";
import { createHttpRelyingParty } from "./http-relying-party";
import { createLocalRelyingParty } from "./local-relying-party";
import type { RelyingParty } from "./types";

export * from "./errors";
export type * from "./types";
export * from "./webauthn";

const RP_NAME = "creating space";

/**
 * Picks where passkeys are verified and stored: in this browser by default, or
 * on the backend at PUBLIC_PASSKEY_API_URL. Both speak the same JSON contract,
 * so the UI does not change. Browser-only — call it after hydration.
 */
export const createRelyingParty = (): RelyingParty => {
	const apiUrl = env.PUBLIC_PASSKEY_API_URL?.trim();
	return apiUrl
		? createHttpRelyingParty({
				baseUrl: apiUrl,
				rpId: env.PUBLIC_PASSKEY_RP_ID?.trim() || undefined,
			})
		: createLocalRelyingParty({ rpName: RP_NAME });
};
