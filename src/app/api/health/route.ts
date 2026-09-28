import { passkeyBackend } from "@/lib/server/passkey/runtime";

/**
 * For uptime checks and deploy scripts (BR-OPS-7): a trivial query proves
 * the database is reachable. Neon suspends an idle database and bills the
 * time it runs, so a monitor calling this every minute keeps it awake.
 */
export const GET = async () => {
	const headers = { "Cache-Control": "no-store" };
	try {
		const backend = passkeyBackend();
		await backend.db.query("SELECT 1");
		return Response.json({ ok: true }, { headers });
	} catch (error) {
		console.error("[health] the passkey backend is unavailable:", error);
		return Response.json({ ok: false }, { status: 503, headers });
	}
};
