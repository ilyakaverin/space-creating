import { startRegistration } from "@/lib/server/passkey/ceremonies";
import { ensureFlowId } from "@/lib/server/passkey/cookies";
import { passkeyEndpoint, readJson } from "@/lib/server/passkey/http";

/**
 * Step 1 of registration: creation options out, for a new account with a
 * generated name. Also sets the flow cookie the challenge is tied to.
 */
export const POST = passkeyEndpoint(
	async ({ request, cookies, backend, context }) => {
		// The body carries nothing, but must still be JSON (BR-GEN-2).
		await readJson(request);
		const flowId = ensureFlowId(cookies, backend.config);
		return Response.json(
			await startRegistration(backend, { ...context, flowId }),
		);
	},
);
