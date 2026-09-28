import { beforeEach, describe, expect, it } from "vitest";
import {
	CHALLENGE_TTL_MS,
	type ChallengeStore,
	EXPIRED_RETENTION_MS,
	MAX_CHALLENGES_PER_FLOW,
	createChallengeStore,
} from "./challenges";
import { ApiError } from "./errors";
import { createTestDatabase } from "./test-database";

let time: number;
let store: ChallengeStore;

beforeEach(async () => {
	time = 1_000_000;
	store = createChallengeStore(await createTestDatabase(), () => time);
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

describe("challenge store", () => {
	it("returns a registration challenge with its pending account exactly once", async () => {
		const pendingUser = { id: "handle", name: "Traveller 7K3QX2" };
		await store.issue({
			challenge: "c1",
			flowId: "flow",
			type: "registration",
			pendingUser,
		});
		const record = await store.redeem({
			challenge: "c1",
			flowId: "flow",
			type: "registration",
		});
		expect(record).toEqual({
			challenge: "c1",
			type: "registration",
			pendingUser,
			expiresAt: time + CHALLENGE_TTL_MS,
		});
		// Single use: the second attempt finds nothing.
		expect(
			await codeOf(() =>
				store.redeem({ challenge: "c1", flowId: "flow", type: "registration" }),
			),
		).toBe("verification_failed");
	});

	it("only accepts a challenge from the browser it was issued to", async () => {
		await store.issue({
			challenge: "c1",
			flowId: "mine",
			type: "authentication",
		});
		expect(
			await codeOf(() =>
				store.redeem({
					challenge: "c1",
					flowId: "theirs",
					type: "authentication",
				}),
			),
		).toBe("verification_failed");
		expect(
			await codeOf(() =>
				store.redeem({ challenge: "c1", flowId: null, type: "authentication" }),
			),
		).toBe("verification_failed");
		// The failed attempts from elsewhere did not burn it for its owner.
		const record = await store.redeem({
			challenge: "c1",
			flowId: "mine",
			type: "authentication",
		});
		expect(record.type).toBe("authentication");
		expect(record.pendingUser).toBeNull();
	});

	it("refuses a challenge presented for the other ceremony", async () => {
		await store.issue({
			challenge: "c1",
			flowId: "flow",
			type: "authentication",
		});
		expect(
			await codeOf(() =>
				store.redeem({ challenge: "c1", flowId: "flow", type: "registration" }),
			),
		).toBe("verification_failed");
	});

	it("reports expiry distinctly, and cleanup removes rows only after the retention period", async () => {
		await store.issue({
			challenge: "old",
			flowId: "flow",
			type: "authentication",
		});
		await store.issue({
			challenge: "older",
			flowId: "flow",
			type: "authentication",
		});
		time += CHALLENGE_TTL_MS;
		// Cleanup keeps freshly expired rows, so a late answer still hears "expired".
		expect(await store.deleteExpired()).toBe(0);
		time += EXPIRED_RETENTION_MS - 1;
		expect(
			await codeOf(() =>
				store.redeem({
					challenge: "old",
					flowId: "flow",
					type: "authentication",
				}),
			),
		).toBe("challenge_expired");
		time += 1;
		expect(await store.deleteExpired()).toBe(1);
	});

	it("keeps only the newest challenges per browser", async () => {
		for (let index = 0; index <= MAX_CHALLENGES_PER_FLOW; index++) {
			await store.issue({
				challenge: `c${index}`,
				flowId: "flow",
				type: "authentication",
			});
		}
		await store.issue({
			challenge: "other",
			flowId: "other",
			type: "authentication",
		});
		expect(
			await codeOf(() =>
				store.redeem({
					challenge: "c0",
					flowId: "flow",
					type: "authentication",
				}),
			),
		).toBe("verification_failed");
		for (const [challenge, flowId] of [
			["c1", "flow"],
			[`c${MAX_CHALLENGES_PER_FLOW}`, "flow"],
			["other", "other"],
		]) {
			expect(
				(await store.redeem({ challenge, flowId, type: "authentication" }))
					.challenge,
			).toBe(challenge);
		}
	});
});
