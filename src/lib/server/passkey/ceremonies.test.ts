import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { describe, expect, it } from "vitest";
import { readSignCount, signCountRegressed } from "./ceremonies";

describe("signature counter", () => {
	it("reads the big-endian counter after the RP ID hash and flags", () => {
		const authenticatorData = new Uint8Array(37);
		authenticatorData.set([0, 0, 1, 2], 33);
		expect(readSignCount(isoBase64URL.fromBuffer(authenticatorData))).toBe(258);
	});

	it("flags a counter that does not grow, but not synced passkeys that stay at 0", () => {
		expect(signCountRegressed(0, 0)).toBe(false);
		expect(signCountRegressed(5, 6)).toBe(false);
		expect(signCountRegressed(0, 1)).toBe(false);
		expect(signCountRegressed(5, 5)).toBe(true);
		expect(signCountRegressed(5, 4)).toBe(true);
		expect(signCountRegressed(5, 0)).toBe(true);
	});
});
