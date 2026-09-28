import { describe, expect, it } from "vitest";
import {
	type Db,
	MIGRATIONS,
	type Sql,
	migrate,
	migrateOnFirstUse,
} from "./database";
import { createEmptyTestDatabase, createTestDatabase } from "./test-database";

describe("migrations", () => {
	it("apply once, and do nothing when run again", async () => {
		const db = await createTestDatabase();
		await migrate(db);
		const { rows } = await db.query<{ version: number }>(
			"SELECT version FROM schema_migrations ORDER BY version",
		);
		expect(rows).toEqual([{ version: 1 }, { version: 2 }]);
	});

	it("give accounts from before usernames a unique name key", async () => {
		const db = createEmptyTestDatabase();
		// The state a database was in after the first release: version 1.
		await db.query(MIGRATIONS[0]);
		await db.query(
			"CREATE TABLE schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
		);
		await db.query("INSERT INTO schema_migrations (version) VALUES ($1)", [1]);
		const now = new Date();
		for (const [id, name] of [
			["u1", "Traveller 7K3QX2"],
			["u2", "Traveller 7k3qx2"],
			["u3", "Traveller AAAAAA"],
		]) {
			await db.query(
				"INSERT INTO users (id, name, created_at) VALUES ($1, $2, $3)",
				[id, name, now],
			);
		}
		await migrate(db);
		const { rows } = await db.query<{ id: string; name_key: string }>(
			"SELECT id, name_key FROM users ORDER BY id",
		);
		expect(rows).toEqual([
			{ id: "u1", name_key: "traveller 7k3qx2" },
			{ id: "u2", name_key: "traveller 7k3qx2 u2" },
			{ id: "u3", name_key: "traveller aaaaaa" },
		]);
		await db.close();
	});

	it("refuse a database migrated by newer code", async () => {
		const db = await createTestDatabase();
		await db.query("INSERT INTO schema_migrations (version) VALUES ($1)", [99]);
		await expect(migrate(db)).rejects.toThrow(/newer than this code/);
		await db.query("DELETE FROM schema_migrations WHERE version = $1", [99]);
	});
});

/**
 * Records what reaches the database. Every query answers with the latest
 * schema version, so a migration finds nothing to do; `failNext` makes the next transaction
 * fail as if the database were unreachable.
 */
const recordingDb = () => {
	const calls: string[] = [];
	const state = { failNext: false };
	const sql: Sql = {
		async query<Row>(text: string) {
			calls.push(text.trim().split(/\s+/)[0]);
			return { rows: [{ version: MIGRATIONS.length }] as Row[], rowCount: 0 };
		},
	};
	const db: Db = {
		...sql,
		async transaction(fn) {
			if (state.failNext) {
				state.failNext = false;
				throw new Error("connection refused");
			}
			calls.push("BEGIN");
			return fn(sql);
		},
		close: async () => undefined,
	};
	return { db, calls, state };
};

describe("migrateOnFirstUse", () => {
	it("touches the database only when the first query needs it, and migrates once", async () => {
		const { db, calls } = recordingDb();
		const lazy = migrateOnFirstUse(db);
		expect(calls).toEqual([]);

		await lazy.query("SELECT 1");
		expect(calls[0]).toBe("BEGIN");
		expect(calls.at(-1)).toBe("SELECT");
		const afterFirst = calls.length;

		await lazy.query("SELECT 2");
		await lazy.transaction(async (tx) => tx.query("DELETE FROM x"));
		expect(calls.slice(afterFirst)).toEqual(["SELECT", "BEGIN", "DELETE"]);
	});

	it("tries the migrations again after a failure", async () => {
		const { db, calls, state } = recordingDb();
		const lazy = migrateOnFirstUse(db);
		state.failNext = true;
		await expect(lazy.query("SELECT 1")).rejects.toThrow("connection refused");
		expect(calls).toEqual([]);

		await lazy.query("SELECT 1");
		expect(calls[0]).toBe("BEGIN");
		expect(calls.at(-1)).toBe("SELECT");
	});
});
