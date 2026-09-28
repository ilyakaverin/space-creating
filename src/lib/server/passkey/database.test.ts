import { describe, expect, it } from "vitest";
import { migrate } from "./database";
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
