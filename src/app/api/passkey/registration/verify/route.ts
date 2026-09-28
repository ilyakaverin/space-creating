import { finishRegistration } from "@/lib/server/passkey/ceremonies";
import { readFlowId, setSessionCookie } from "@/lib/server/passkey/cookies";
import { passkeyEndpoint, readJson } from "@/lib/server/passkey/http";

/**
 * Step 2 of registration: the new credential in, `{ user }` out. On success
 * the passkey is stored and the session cookie set.
 */
export const POST = passkeyEndpoint(
	async ({ request, cookies, backend, context }) => {
		const body = await readJson(request);
		const flowId = readFlowId(cookies, backend.config);
		const { user, session } = await finishRegistration(
			backend,
			{ ...context, flowId },
			body,
		);
		setSessionCookie(cookies, backend.config, session);
		return Response.json({ user });
	},
);
