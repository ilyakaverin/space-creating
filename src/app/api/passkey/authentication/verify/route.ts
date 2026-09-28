import { finishAuthentication } from "@/lib/server/passkey/ceremonies";
import {
	readFlowId,
	setDeviceCredentials,
	setSessionCookie,
} from "@/lib/server/passkey/cookies";
import { withDeviceCredential } from "@/lib/server/passkey/device-credentials";
import { passkeyEndpoint, readJson } from "@/lib/server/passkey/http";

/** Step 2 of sign-in: the assertion in, `{ user }` out, session cookie set. */
export const POST = passkeyEndpoint(
	async ({ request, cookies, backend, context }) => {
		const body = await readJson(request);
		const flowId = readFlowId(cookies, backend.config);
		const { user, session, credentialId } = await finishAuthentication(
			backend,
			{ ...context, flowId },
			body,
		);
		setSessionCookie(cookies, backend.config, session);
		// This browser now has a passkey here: it gets no second one (BR-REGO-9).
		setDeviceCredentials(
			cookies,
			backend.config,
			withDeviceCredential(context.deviceCredentialIds, credentialId),
		);
		return Response.json({ user });
	},
);
