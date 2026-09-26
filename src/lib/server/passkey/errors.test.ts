import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors";

describe("ApiError", () => {
	it("is recognised when thrown by another copy of the module", async () => {
		// What Next.js does to instrumentation.ts and the route handlers:
		// two separately loaded copies of errors.ts.
		vi.resetModules();
		const copy = await import("./errors");
		expect(copy.ApiError).not.toBe(ApiError);

		const error = new copy.ApiError("rate_limited", "Slow down.");
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toBeInstanceOf(Error);
		expect(error.status).toBe(429);
		expect(new Error("plain")).not.toBeInstanceOf(ApiError);
		expect(null).not.toBeInstanceOf(ApiError);
	});
});
