import { beforeEach, describe, expect, it } from "vitest";
import { createAccountStore } from "./accounts";
import {
	CHALLENGE_TTL_MS,
	type ChallengeStore,
	MAX_CHALLENGES_PER_FLOW,
	createChallengeStore,
} from "./challenges";
import { type Db, openDatabase } from "./database";
import { ApiError } from "./errors";

let time: number;
let db: Db;
let store: ChallengeStore;

beforeEach(() => {
	time = 1_000_000;
	db = openDatabase(":memory:");
	store = createChallengeStore(db, () => time);
});

const codeOf = (run: () => unknown): string | undefined => {
	try {
		run();
	} catch (error) {
		return error instanceof ApiError ? error.code : "not an ApiError";
	}
	return undefined;
};

describe("challenge store", () => {
	it("returns a registration challenge with its pending user exactly once", () => {
		const pendingUser = { id: "handle", name: "alice", displayName: "Alice" };
		store.issue({
			challenge: "c1",
			flowId: "flow",
			type: "registration",
			pendingUser,
		});
		const record = store.redeem({
			challenge: "c1",
			flowId: "flow",
			type: "registration",
		});
		expect(record.pendingUser).toEqual(pendingUser);
		expect(record.sessionUserId).toBeNull();
		// Single use: the second attempt finds nothing.
		expect(
			codeOf(() =>
				store.redeem({ challenge: "c1", flowId: "flow", type: "registration" }),
			),
		).toBe("verification_failed");
	});

	it("only accepts a challenge from the browser it was issued to", () => {
		store.issue({ challenge: "c1", flowId: "mine", type: "authentication" });
		expect(
			codeOf(() =>
				store.redeem({
					challenge: "c1",
					flowId: "theirs",
					type: "authentication",
				}),
			),
		).toBe("verification_failed");
		expect(
			codeOf(() =>
				store.redeem({ challenge: "c1", flowId: null, type: "authentication" }),
			),
		).toBe("verification_failed");
		// The failed attempts from elsewhere did not burn it for its owner.
		expect(
			store.redeem({ challenge: "c1", flowId: "mine", type: "authentication" })
				.type,
		).toBe("authentication");
	});

	it("refuses a challenge presented for the other ceremony", () => {
		store.issue({ challenge: "c1", flowId: "flow", type: "authentication" });
		expect(
			codeOf(() =>
				store.redeem({ challenge: "c1", flowId: "flow", type: "registration" }),
			),
		).toBe("verification_failed");
	});

	it("reports expiry distinctly, and cleanup removes expired rows", () => {
		store.issue({ challenge: "old", flowId: "flow", type: "authentication" });
		store.issue({ challenge: "older", flowId: "flow", type: "authentication" });
		time += CHALLENGE_TTL_MS;
		expect(
			codeOf(() =>
				store.redeem({
					challenge: "old",
					flowId: "flow",
					type: "authentication",
				}),
			),
		).toBe("challenge_expired");
		expect(store.deleteExpired()).toBe(1);
	});

	it("keeps only the newest challenges per browser", () => {
		for (let index = 0; index <= MAX_CHALLENGES_PER_FLOW; index++) {
			store.issue({
				challenge: `c${index}`,
				flowId: "flow",
				type: "authentication",
			});
		}
		store.issue({
			challenge: "other",
			flowId: "other",
			type: "authentication",
		});
		expect(
			codeOf(() =>
				store.redeem({
					challenge: "c0",
					flowId: "flow",
					type: "authentication",
				}),
			),
		).toBe("verification_failed");
		expect(
			store.redeem({
				challenge: `c${MAX_CHALLENGES_PER_FLOW}`,
				flowId: "flow",
				type: "authentication",
			}).challenge,
		).toBe(`c${MAX_CHALLENGES_PER_FLOW}`);
		expect(
			store.redeem({
				challenge: "other",
				flowId: "other",
				type: "authentication",
			}).challenge,
		).toBe("other");
	});

	it("drops an add-passkey challenge when its account is deleted", () => {
		const accounts = createAccountStore(db, () => time);
		accounts.createUser({ id: "u1", name: "alice", displayName: "Alice" });
		store.issue({
			challenge: "c1",
			flowId: "flow",
			type: "registration",
			sessionUserId: "u1",
		});
		accounts.deleteUser("u1");
		expect(
			codeOf(() =>
				store.redeem({ challenge: "c1", flowId: "flow", type: "registration" }),
			),
		).toBe("verification_failed");
	});
});
