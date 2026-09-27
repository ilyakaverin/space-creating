import { passkeyBackend } from "@/lib/server/passkey/runtime";

/**
 * For uptime checks and deploy scripts (BR-OPS-7). With the passkey backend
 * on, a trivial query proves the database is reachable.
 */
export const GET = () => {
	const backend = passkeyBackend();
	backend?.db.prepare("SELECT 1").get();
	return Response.json(
		{ ok: true, passkeyBackend: backend ? "on" : "off" },
		{ headers: { "Cache-Control": "no-store" } },
	);
};
