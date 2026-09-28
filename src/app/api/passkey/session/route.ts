import { signOut } from "@/lib/server/passkey/ceremonies";
import { clearSessionCookie } from "@/lib/server/passkey/cookies";
import { noContent, passkeyEndpoint } from "@/lib/server/passkey/http";

/**
 * Who is signed in. Always 200 — `{ user: null }` when nobody is — because
 * the frontend asks on every page load (BR-SES-1). The wrapper has already
 * resolved the cookie and cleared it if it was stale. `devicePasskey` says
 * whether this browser already has a passkey here (BR-REGO-9); it comes from
 * the device cookie alone, so a signed-out visitor still needs no database.
 * HEAD is answered by this handler too: Next.js runs GET for it and drops
 * the body.
 */
export const GET = passkeyEndpoint(async ({ context }) =>
	Response.json({
		user: context.user,
		devicePasskey: context.deviceCredentialIds.length > 0,
	}),
);

/** Sign out: the session row is deleted server-side, not just the cookie. */
export const DELETE = passkeyEndpoint(async ({ cookies, backend, context }) => {
	await signOut(backend, context);
	clearSessionCookie(cookies, backend.config);
	return noContent();
});
