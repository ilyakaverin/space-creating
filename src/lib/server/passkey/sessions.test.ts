import { beforeEach, describe, expect, it } from "vitest";
import { createAccountStore } from "./accounts";
import type { Db } from "./database";
import { type SessionStore, createSessionStore, hashToken } from "./sessions";
import { createTestDatabase } from "./test-database";

const HOUR = 60 * 60 * 1000;
const TTL = 30 * 24 * HOUR;

let time: number;
let db: Db;
let sessions: SessionStore;

beforeEach(async () => {
	time = 1_000_000;
	db = await createTestDatabase();
	sessions = createSessionStore(db, { ttlMs: TTL, now: () => time });
	await createAccountStore(db, () => time).createUser({
		id: "u1",
		name: "Traveller 7K3QX2",
	});
});

describe("session store", () => {
	it("stores only the token's hash and resolves the token to its user", async () => {
		const { token, expiresAt } = await sessions.create("u1", "test agent");
		expect(expiresAt).toBe(time + TTL);
		const { rows } = await db.query("SELECT token_hash FROM sessions");
		expect(rows).toEqual([{ token_hash: hashToken(token) }]);
		expect(JSON.stringify(rows)).not.toContain(token);

		expect(await sessions.validate(token)).toEqual({
			tokenHash: hashToken(token),
			user: { id: "u1", name: "Traveller 7K3QX2" },
			expiresAt,
			refreshed: false,
		});
	});

	it("rejects unknown, malformed and revoked tokens", async () => {
		const { token } = await sessions.create("u1", null);
		expect(await sessions.validate("x".repeat(43))).toBeNull();
		expect(await sessions.validate("not a token")).toBeNull();
		await sessions.revoke(hashToken(token));
		expect(await sessions.validate(token)).toBeNull();
	});

	it("extends the expiry once less than half the lifetime is left", async () => {
		const { token } = await sessions.create("u1", null);
		time += TTL / 2 - HOUR;
		expect((await sessions.validate(token))?.refreshed).toBe(false);
		time += 2 * HOUR;
		const refreshed = await sessions.validate(token);
		expect(refreshed?.refreshed).toBe(true);
		expect(refreshed?.expiresAt).toBe(time + TTL);
		// The new expiry was stored, not just reported.
		time += TTL / 2 - HOUR;
		expect((await sessions.validate(token))?.refreshed).toBe(false);
	});

	it("expires idle sessions and deletes them", async () => {
		const { token } = await sessions.create("u1", null);
		await sessions.create("u1", null);
		time += TTL;
		expect(await sessions.validate(token)).toBeNull();
		expect(await sessions.deleteExpired()).toBe(1);
	});

	it("disappears with its account", async () => {
		const { token } = await sessions.create("u1", null);
		await db.query("DELETE FROM users WHERE id = $1", ["u1"]);
		expect(await sessions.validate(token)).toBeNull();
	});
});
