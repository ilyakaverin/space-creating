import { beforeEach, describe, expect, it } from "vitest";
import { type AccountStore, createAccountStore } from "./accounts";
import { type Db, openDatabase } from "./database";
import { type SessionStore, createSessionStore, hashToken } from "./sessions";

const HOUR = 60 * 60 * 1000;
const TTL = 30 * 24 * HOUR;

let time: number;
let db: Db;
let accounts: AccountStore;
let sessions: SessionStore;

beforeEach(() => {
	time = 1_000_000;
	db = openDatabase(":memory:");
	accounts = createAccountStore(db, () => time);
	sessions = createSessionStore(db, { ttlMs: TTL, now: () => time });
	accounts.createUser({ id: "u1", name: "alice", displayName: "Alice" });
});

describe("session store", () => {
	it("stores only the token's hash and resolves the token to its user", () => {
		const { token, expiresAt } = sessions.create("u1", "test agent");
		expect(expiresAt).toBe(time + TTL);
		const stored = db.prepare("SELECT token_hash FROM sessions").all() as {
			token_hash: string;
		}[];
		expect(stored).toEqual([{ token_hash: hashToken(token) }]);
		expect(JSON.stringify(stored)).not.toContain(token);

		expect(sessions.validate(token)).toMatchObject({
			user: { id: "u1", name: "alice", displayName: "Alice" },
			refreshed: false,
		});
	});

	it("rejects unknown, malformed and revoked tokens", () => {
		const { token } = sessions.create("u1", null);
		expect(sessions.validate("x".repeat(43))).toBeNull();
		expect(sessions.validate("not a token")).toBeNull();
		sessions.revoke(hashToken(token));
		expect(sessions.validate(token)).toBeNull();
	});

	it("extends the expiry once less than half the lifetime is left", () => {
		const { token } = sessions.create("u1", null);
		time += TTL / 2 - HOUR;
		expect(sessions.validate(token)?.refreshed).toBe(false);
		time += 2 * HOUR;
		const refreshed = sessions.validate(token);
		expect(refreshed?.refreshed).toBe(true);
		expect(refreshed?.expiresAt).toBe(time + TTL);
	});

	it("expires idle sessions and deletes them", () => {
		const { token } = sessions.create("u1", null);
		sessions.create("u1", null);
		time += TTL;
		expect(sessions.validate(token)).toBeNull();
		expect(sessions.deleteExpired()).toBe(1);
	});

	it("disappears with its account", () => {
		const { token } = sessions.create("u1", null);
		accounts.deleteUser("u1");
		expect(sessions.validate(token)).toBeNull();
	});
});
