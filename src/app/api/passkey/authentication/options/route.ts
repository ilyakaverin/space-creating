import { startAuthentication } from "@/lib/server/passkey/ceremonies";
import { ensureFlowId } from "@/lib/server/passkey/cookies";
import { passkeyEndpoint, readJson } from "@/lib/server/passkey/http";

/**
 * Step 1 of sign-in: request options out. The frontend calls this on page
 * load for autofill as well as on the sign-in button.
 */
export const POST = passkeyEndpoint(
	async ({ request, cookies, backend, context }) => {
		// The body carries nothing, but must still be JSON (BR-GEN-2).
		await readJson(request);
		const flowId = ensureFlowId(cookies, backend.config);
		return Response.json(
			await startAuthentication(backend, { ...context, flowId }),
		);
	},
);
