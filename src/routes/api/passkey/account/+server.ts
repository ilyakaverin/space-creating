import { deleteAccount } from "$lib/server/passkey/ceremonies";
import { clearSessionCookie } from "$lib/server/passkey/cookies";
import { noContent, passkeyEndpoint } from "$lib/server/passkey/http";

/**
 * Deletes the signed-in account with its passkeys and every session. The
 * frontend then tells the password manager to drop the passkeys.
 */
export const DELETE = passkeyEndpoint(async ({ event, backend, context }) => {
	deleteAccount(backend, context);
	clearSessionCookie(event.cookies, backend.config);
	return noContent();
});
