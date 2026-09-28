import { startAuthentication } from "@/lib/server/passkey/ceremonies";
import { ensureFlowId } from "@/lib/server/passkey/cookies";
import { passkeyEndpoint, readJson } from "@/lib/server/passkey/http";

/**
 * Step 1 of sign-in: `{ userName? }` in, request options out — for that
 * account's passkeys, or for any passkey the device holds for the site.
 */
export const POST = passkeyEndpoint(
	async ({ request, cookies, backend, context }) => {
		const body = await readJson(request);
		const flowId = ensureFlowId(cookies, backend.config);
		return Response.json(
			await startAuthentication(backend, { ...context, flowId }, body),
		);
	},
);
