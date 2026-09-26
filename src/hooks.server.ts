import { dev } from "$app/environment";
import { ConfigError } from "$lib/server/passkey/config";
import {
	passkeyBackend,
	resolvePasskeySession,
} from "$lib/server/passkey/runtime";
import type { Handle, ServerInit } from "@sveltejs/kit";

/**
 * Runs once before the server takes requests. With the passkey backend
 * enabled, bad configuration or an unusable database stops the server here
 * instead of failing on the first sign-in (BR-OPS-1).
 */
export const init: ServerInit = () => {
	try {
		passkeyBackend();
	} catch (error) {
		if (error instanceof ConfigError && !dev) {
			// Just the list of problems, not a stack trace through minified code.
			console.error(error.message);
			process.exit(1);
		}
		throw error;
	}
};

/** On every request, turns the session cookie into `event.locals.user`. */
export const handle: Handle = ({ event, resolve }) => {
	resolvePasskeySession(event);
	return resolve(event);
};
