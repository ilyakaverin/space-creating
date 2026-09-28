import { describe, expect, it } from "vitest";
import { type Db, type Sql, migrate, migrateOnFirstUse } from "./database";
import { createTestDatabase } from "./test-database";

describe("migrations", () => {
	it("apply once, and do nothing when run again", async () => {
		const db = await createTestDatabase();
		await migrate(db);
		const { rows } = await db.query<{ version: number }>(
			"SELECT version FROM schema_migrations ORDER BY version",
		);
		expect(rows).toEqual([{ version: 1 }]);
	});

	it("refuse a database migrated by newer code", async () => {
		const db = await createTestDatabase();
		await db.query("INSERT INTO schema_migrations (version) VALUES ($1)", [99]);
		await expect(migrate(db)).rejects.toThrow(/newer than this code/);
		await db.query("DELETE FROM schema_migrations WHERE version = $1", [99]);
	});
});

/**
 * Records what reaches the database. Every query answers "schema version 1",
 * so a migration finds nothing to do; `failNext` makes the next transaction
 * fail as if the database were unreachable.
 */
const recordingDb = () => {
	const calls: string[] = [];
	const state = { failNext: false };
	const sql: Sql = {
		async query<Row>(text: string) {
			calls.push(text.trim().split(/\s+/)[0]);
			return { rows: [{ version: 1 }] as Row[], rowCount: 0 };
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
