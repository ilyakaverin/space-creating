import { describe, expect, it } from "vitest";
import { ApiError } from "./errors";
import { createRateLimiter } from "./rate-limit";
import { createTestDatabase } from "./test-database";

const rejectionOf = async (run: () => Promise<unknown>): Promise<unknown> => {
	try {
		await run();
	} catch (error) {
		return error;
	}
	return undefined;
};

describe("rate limiter", () => {
	it("allows the limit, then answers rate_limited with Retry-After until the window ends", async () => {
		let time = 0;
		const limiter = createRateLimiter(await createTestDatabase(), () => time);
		const rule = { limit: 2, windowMs: 60_000 };
		await limiter.consume("ip", rule);
		await limiter.consume("ip", rule);

		time = 15_000;
		const error = await rejectionOf(() => limiter.consume("ip", rule));
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).code).toBe("rate_limited");
		expect((error as ApiError).headers["Retry-After"]).toBe("45");

		// Other keys have their own window.
		await expect(limiter.consume("other ip", rule)).resolves.toBeUndefined();
		// A new window starts once the old one ends.
		time = 60_000;
		await expect(limiter.consume("ip", rule)).resolves.toBeUndefined();
		// Cleanup drops ended windows: "other ip" (15 s to 75 s), not the new one.
		time = 75_000;
		expect(await limiter.prune()).toBe(1);
	});

	it("counts concurrent requests without losing any", async () => {
		const limiter = createRateLimiter(await createTestDatabase(), () => 0);
		const rule = { limit: 5, windowMs: 60_000 };
		const results = await Promise.allSettled(
			Array.from({ length: 8 }, () => limiter.consume("ip", rule)),
		);
		expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
			3,
		);
	});
});
