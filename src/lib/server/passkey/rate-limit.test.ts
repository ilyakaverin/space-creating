import { describe, expect, it } from "vitest";
import { ApiError } from "./errors";
import { createRateLimiter } from "./rate-limit";

describe("rate limiter", () => {
	it("allows the limit, then answers rate_limited with Retry-After until the window ends", () => {
		let time = 0;
		const limiter = createRateLimiter(() => time);
		const rule = { limit: 2, windowMs: 60_000 };
		limiter.consume("ip", rule);
		limiter.consume("ip", rule);

		time = 15_000;
		let error: unknown;
		try {
			limiter.consume("ip", rule);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).code).toBe("rate_limited");
		expect((error as ApiError).headers["Retry-After"]).toBe("45");

		// Other keys have their own window.
		expect(() => limiter.consume("other ip", rule)).not.toThrow();
		// A new window starts once the old one ends.
		time = 60_000;
		expect(() => limiter.consume("ip", rule)).not.toThrow();
	});
});
