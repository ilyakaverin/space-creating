import { startAuthentication } from "$lib/server/passkey/ceremonies";
import { useFlowId } from "$lib/server/passkey/cookies";
import { passkeyEndpoint, readJson } from "$lib/server/passkey/http";
import { json } from "@sveltejs/kit";

/**
 * Step 1 of sign-in: request options out. The frontend calls this on page
 * load for autofill as well as on the sign-in button.
 */
export const POST = passkeyEndpoint(async ({ event, backend, context }) => {
	// The body carries nothing, but must still be JSON (BR-GEN-2).
	await readJson(event.request);
	const flowId = useFlowId(event.cookies, backend.config);
	return json(await startAuthentication(backend, { ...context, flowId }));
});
