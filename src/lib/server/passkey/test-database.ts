/**
 * For unit tests only: the real schema and SQL, run by PGlite — Postgres
 * compiled to WebAssembly, in memory, no server needed.
 */
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { type Db, type Sql, migrate } from "./database";

const adapt = (target: PGlite | Transaction): Sql => ({
	async query<Row>(text: string, params?: unknown[]) {
		// Like node-postgres, text without parameters may hold several
		// statements (a migration does); the last one's result is returned.
		if (!params?.length) {
			const last = (await target.exec(text)).at(-1);
			return {
				rows: (last?.rows ?? []) as Row[],
				rowCount: last?.affectedRows ?? 0,
			};
		}
		const result = await target.query<Row>(text, params);
		return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
	},
});

/** Starting PGlite takes seconds, so each test file shares one and empties it per test. */
let shared: Promise<Db> | undefined;

/** A fresh database without any tables, for testing the migrations themselves. */
export const createEmptyTestDatabase = (): Db => {
	const pglite = new PGlite();
	return {
		...adapt(pglite),
		transaction: (fn) => pglite.transaction((tx) => fn(adapt(tx))),
		close: () => pglite.close(),
	};
};

const start = async (): Promise<Db> => {
	const db = createEmptyTestDatabase();
	await migrate(db);
	return db;
};

/** A migrated database with every table empty. */
export const createTestDatabase = async (): Promise<Db> => {
	shared ??= start();
	const db = await shared;
	await db.query(
		"TRUNCATE users, credentials, sessions, challenges, rate_limits RESTART IDENTITY",
	);
	return db;
};
