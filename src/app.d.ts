// See https://svelte.dev/docs/kit/types#app.d.ts
import type { User } from "$lib/server/passkey/accounts";

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			/** The signed-in passkey user, resolved from the session cookie in hooks.server.ts. */
			user: User | null;
			/** Identifies the current session row, so sign-out and sign-in can revoke it. */
			sessionTokenHash: string | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}
