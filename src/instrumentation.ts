/**
 * Next.js calls `register` once when the server starts, before it takes
 * requests. This file is also compiled for the Edge runtime, which cannot
 * open SQLite, so the Node.js-only code is imported inside the check (the
 * build drops that branch from the Edge bundle).
 */
export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		const { startPasskeyBackend } = await import(
			"./lib/server/passkey/runtime"
		);
		startPasskeyBackend();
	}
}
