import { signOut } from "$lib/server/passkey/ceremonies";
import { clearSessionCookie } from "$lib/server/passkey/cookies";
import { noContent, passkeyEndpoint } from "$lib/server/passkey/http";
import { json } from "@sveltejs/kit";

/**
 * Who is signed in. Always 200 — `{ user: null }` when nobody is — because
 * the frontend asks on every page load (BR-SES-1). hooks.server.ts has
 * already resolved the cookie and cleared it if it was stale.
 */
export const GET = passkeyEndpoint(async ({ context }) =>
	json({ user: context.user }),
);

/** Sign out: the session row is deleted server-side, not just the cookie. */
export const DELETE = passkeyEndpoint(async ({ event, backend, context }) => {
	signOut(backend, context);
	clearSessionCookie(event.cookies, backend.config);
	return noContent();
});
