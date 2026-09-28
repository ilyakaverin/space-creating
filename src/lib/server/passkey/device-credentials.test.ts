import { describe, expect, it } from "vitest";
import {
	MAX_DEVICE_CREDENTIALS,
	parseDeviceCredentials,
	serializeDeviceCredentials,
	withDeviceCredential,
} from "./device-credentials";

describe("device credentials cookie", () => {
	it("round-trips a list and drops malformed or repeated entries", () => {
		expect(
			parseDeviceCredentials(serializeDeviceCredentials(["a1", "b_2"])),
		).toEqual(["a1", "b_2"]);
		expect(parseDeviceCredentials("a1..b=2.a1.c-3")).toEqual(["a1", "c-3"]);
		expect(parseDeviceCredentials(undefined)).toEqual([]);
		expect(parseDeviceCredentials("")).toEqual([]);
	});

	it("puts the newest passkey first and keeps a bounded number", () => {
		expect(withDeviceCredential(["a", "b"], "b")).toEqual(["b", "a"]);
		const many = Array.from({ length: 10 }, (_, index) => `id${index}`);
		expect(withDeviceCredential(many, "new")).toEqual([
			"new",
			...many.slice(0, MAX_DEVICE_CREDENTIALS - 1),
		]);
		expect(parseDeviceCredentials(many.join("."))).toHaveLength(
			MAX_DEVICE_CREDENTIALS,
		);
	});

	it("drops the oldest IDs rather than exceed a cookie's size", () => {
		const huge = ["n".repeat(1364), "o".repeat(1364), "p".repeat(1364)];
		const value = serializeDeviceCredentials(huge);
		expect(value.length).toBeLessThanOrEqual(3_000);
		expect(parseDeviceCredentials(value)).toEqual(huge.slice(0, 2));
	});
});
