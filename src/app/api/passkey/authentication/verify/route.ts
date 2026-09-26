import { finishAuthentication } from "@/lib/server/passkey/ceremonies";
import { readFlowId, setSessionCookie } from "@/lib/server/passkey/cookies";
import { passkeyEndpoint, readJson } from "@/lib/server/passkey/http";

/** Step 2 of sign-in: the assertion in, `{ user }` out, session cookie set. */
export const POST = passkeyEndpoint(
	async ({ request, cookies, backend, context }) => {
		const body = await readJson(request);
		const flowId = readFlowId(cookies, backend.config);
		const { user, session } = await finishAuthentication(
			backend,
			{ ...context, flowId },
			body,
		);
		setSessionCookie(cookies, backend.config, session);
		return Response.json({ user });
	},
);
