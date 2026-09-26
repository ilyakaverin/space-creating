import { finishRegistration } from "$lib/server/passkey/ceremonies";
import { readFlowId, setSessionCookie } from "$lib/server/passkey/cookies";
import { passkeyEndpoint, readJson } from "$lib/server/passkey/http";
import { json } from "@sveltejs/kit";

/**
 * Step 2 of registration: the new credential in, `{ user }` out. On success
 * the passkey is stored and the session cookie set.
 */
export const POST = passkeyEndpoint(async ({ event, backend, context }) => {
	const body = await readJson(event.request);
	const flowId = readFlowId(event.cookies, backend.config);
	const { user, session } = await finishRegistration(
		backend,
		{ ...context, flowId },
		body,
	);
	setSessionCookie(event.cookies, backend.config, session);
	return json({ user });
});
