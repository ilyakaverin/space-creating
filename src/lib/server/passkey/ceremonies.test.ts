import { describe, expect, it } from "vitest";
import { generateUserName } from "./ceremonies";

describe("generateUserName", () => {
	it("makes a readable random name", () => {
		const names = new Set(Array.from({ length: 50 }, generateUserName));
		for (const name of names) {
			expect(name).toMatch(/^Traveller [0-9A-HJKMNP-TV-Z]{6}$/);
		}
		expect(names.size).toBe(50);
	});
});
