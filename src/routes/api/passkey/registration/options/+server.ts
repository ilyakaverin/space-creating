import { startRegistration } from "$lib/server/passkey/ceremonies";
import { useFlowId } from "$lib/server/passkey/cookies";
import { passkeyEndpoint, readJson } from "$lib/server/passkey/http";
import { json } from "@sveltejs/kit";

/**
 * Step 1 of registration: `{ userName, displayName? }` in, creation options
 * out. Also sets the flow cookie the challenge is tied to.
 */
export const POST = passkeyEndpoint(async ({ event, backend, context }) => {
	const body = await readJson(event.request);
	const flowId = useFlowId(event.cookies, backend.config);
	return json(await startRegistration(backend, { ...context, flowId }, body));
});
