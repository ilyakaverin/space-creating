import { beforeEach, describe, expect, it } from "vitest";
import { type AccountStore, createAccountStore } from "./accounts";
import type { Db } from "./database";
import { ApiError } from "./errors";
import { createTestDatabase } from "./test-database";

let db: Db;
let accounts: AccountStore;

const passkey = (id: string, counter: number) => ({
	id,
	userId: "u1",
	publicKey: new Uint8Array([1, 2, 3]),
	algorithm: -7,
	counter,
	transports: ["internal", "hybrid"],
	aaguid: "00000000-0000-0000-0000-000000000000",
	backupEligible: true,
	backedUp: true,
});

const codeOf = async (
	run: () => Promise<unknown>,
): Promise<string | undefined> => {
	try {
		await run();
	} catch (error) {
		return error instanceof ApiError ? error.code : "not an ApiError";
	}
	return undefined;
};

beforeEach(async () => {
	db = await createTestDatabase();
	accounts = createAccountStore(db, () => 1_000);
	await accounts.createUser({ id: "u1", name: "Traveller 7K3QX2" });
});

describe("account store", () => {
	it("finds a user by name regardless of case, and refuses a second one", async () => {
		expect((await accounts.findUserByName("traveller 7k3qx2"))?.id).toBe("u1");
		expect(await accounts.findUserByName("someone else")).toBeNull();
		expect(
			await codeOf(() =>
				accounts.createUser({ id: "u2", name: "TRAVELLER 7K3QX2" }),
			),
		).toBe("username_taken");
	});

	it("finds a user by handle", async () => {
		expect(await accounts.findUser("u1")).toEqual({
			id: "u1",
			name: "Traveller 7K3QX2",
		});
		expect(await accounts.findUser("u2")).toBeNull();
	});

	it("stores a passkey and reads every field back with its type", async () => {
		// The largest counter an authenticator can send: needs the bigint column.
		await accounts.addCredential(passkey("c1", 2 ** 32 - 1));
		expect(await accounts.findCredential("c1")).toEqual({
			id: "c1",
			userId: "u1",
			publicKey: new Uint8Array([1, 2, 3]),
			algorithm: -7,
			counter: 2 ** 32 - 1,
			transports: ["internal", "hybrid"],
			backupEligible: true,
			backedUp: true,
		});
		expect(await accounts.findCredential("c2")).toBeNull();
	});

	it("lists an account's passkeys for allowCredentials", async () => {
		await accounts.addCredential(passkey("c1", 0));
		expect(await accounts.listCredentials("u1")).toEqual([
			{ id: "c1", transports: ["internal", "hybrid"] },
		]);
		expect(await accounts.listCredentials("nobody")).toEqual([]);
	});

	it("refuses a credential ID that is already stored", async () => {
		await accounts.addCredential(passkey("c1", 0));
		expect(await codeOf(() => accounts.addCredential(passkey("c1", 0)))).toBe(
			"verification_failed",
		);
	});

	it("does not report a missing account as a duplicate passkey", async () => {
		expect(
			await codeOf(() =>
				accounts.addCredential({ ...passkey("c1", 0), userId: "gone" }),
			),
		).toBe("not an ApiError");
	});

	it("rolls back every write of a failed transaction", async () => {
		await expect(
			db.transaction(async (tx) => {
				const inside = createAccountStore(tx, () => 1_000);
				await inside.createUser({ id: "u2", name: "Traveller AAAAAA" });
				await inside.addCredential(passkey("c1", 0));
				// A duplicate: the whole transaction fails.
				await inside.addCredential(passkey("c1", 0));
			}),
		).rejects.toThrow(ApiError);
		expect(await accounts.findUser("u2")).toBeNull();
		expect(await accounts.findCredential("c1")).toBeNull();
	});

	describe("signature counter on sign-in", () => {
		it("accepts a counter that grows and stores it", async () => {
			await accounts.addCredential(passkey("c1", 5));
			expect(
				await accounts.recordSignIn("c1", { counter: 6, backedUp: true }),
			).toBe(true);
			expect((await accounts.findCredential("c1"))?.counter).toBe(6);
		});

		it("rejects a counter that stays or goes back, changing nothing", async () => {
			await accounts.addCredential(passkey("c1", 5));
			for (const counter of [5, 4, 0]) {
				expect(
					await accounts.recordSignIn("c1", { counter, backedUp: true }),
				).toBe(false);
			}
			expect((await accounts.findCredential("c1"))?.counter).toBe(5);
		});

		it("accepts passkeys that never count (synced passkeys report 0)", async () => {
			await accounts.addCredential(passkey("c1", 0));
			expect(
				await accounts.recordSignIn("c1", { counter: 0, backedUp: false }),
			).toBe(true);
			expect((await accounts.findCredential("c1"))?.backedUp).toBe(false);
		});
	});
});
