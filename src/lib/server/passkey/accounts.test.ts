import { beforeEach, describe, expect, it } from "vitest";
import { type AccountStore, createAccountStore } from "./accounts";
import { type Db, openDatabase } from "./database";
import { ApiError } from "./errors";

let db: Db;
let accounts: AccountStore;

const passkey = (id: string, counter: number) => ({
	id,
	userId: "u1",
	publicKey: new Uint8Array([1, 2, 3]),
	algorithm: -7,
	counter,
	transports: ["internal"],
	aaguid: "00000000-0000-0000-0000-000000000000",
	backupEligible: true,
	backedUp: true,
});

const codeOf = (run: () => unknown): string | undefined => {
	try {
		run();
	} catch (error) {
		return error instanceof ApiError ? error.code : "not an ApiError";
	}
	return undefined;
};

beforeEach(() => {
	db = openDatabase(":memory:");
	accounts = createAccountStore(db, () => 1_000);
	accounts.createUser({ id: "u1", name: "Alice", displayName: "Alice A." });
});

describe("account store", () => {
	it("finds users by name regardless of case, and refuses a second Alice", () => {
		expect(accounts.findUserByName("alice")?.id).toBe("u1");
		expect(
			codeOf(() =>
				accounts.createUser({ id: "u2", name: "ALICE", displayName: "" }),
			),
		).toBe("username_taken");
	});

	it("refuses a credential ID that is already stored", () => {
		accounts.addCredential(passkey("c1", 0));
		expect(codeOf(() => accounts.addCredential(passkey("c1", 0)))).toBe(
			"verification_failed",
		);
	});

	it("does not report a missing account as a duplicate passkey", () => {
		expect(
			codeOf(() =>
				accounts.addCredential({ ...passkey("c1", 0), userId: "gone" }),
			),
		).toBe("not an ApiError");
	});

	describe("signature counter on sign-in", () => {
		it("accepts a counter that grows and stores it", () => {
			accounts.addCredential(passkey("c1", 5));
			expect(accounts.recordSignIn("c1", { counter: 6, backedUp: true })).toBe(
				true,
			);
			expect(accounts.findCredential("c1")?.counter).toBe(6);
		});

		it("rejects a counter that stays or goes back, changing nothing", () => {
			accounts.addCredential(passkey("c1", 5));
			expect(accounts.recordSignIn("c1", { counter: 5, backedUp: true })).toBe(
				false,
			);
			expect(accounts.recordSignIn("c1", { counter: 4, backedUp: true })).toBe(
				false,
			);
			expect(accounts.recordSignIn("c1", { counter: 0, backedUp: true })).toBe(
				false,
			);
			expect(accounts.findCredential("c1")?.counter).toBe(5);
		});

		it("accepts passkeys that never count (synced passkeys report 0)", () => {
			accounts.addCredential(passkey("c1", 0));
			expect(accounts.recordSignIn("c1", { counter: 0, backedUp: false })).toBe(
				true,
			);
			expect(accounts.findCredential("c1")?.backedUp).toBe(false);
		});
	});
});
