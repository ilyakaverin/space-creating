import { startRegistration } from "@/lib/server/passkey/ceremonies";
import { ensureFlowId } from "@/lib/server/passkey/cookies";
import { passkeyEndpoint, readJson } from "@/lib/server/passkey/http";

/**
 * Step 1 of registration: `{ userName }` in, creation options for a new
 * account out. Also sets the flow cookie the challenge is tied to.
 */
export const POST = passkeyEndpoint(
	async ({ request, cookies, backend, context }) => {
		const body = await readJson(request);
		const flowId = ensureFlowId(cookies, backend.config);
		return Response.json(
			await startRegistration(backend, { ...context, flowId }, body),
		);
	},
);
