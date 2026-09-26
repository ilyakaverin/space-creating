import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "./config";

const problemsOf = (env: Record<string, string>): string[] => {
	try {
		parseConfig(env);
	} catch (error) {
		if (error instanceof ConfigError) {
			return error.problems;
		}
		throw error;
	}
	return [];
};

describe("parseConfig", () => {
	it("derives the RP ID and cookie security from a single https origin", () => {
		const config = parseConfig({ PASSKEY_ORIGIN: "https://example.com" });
		expect(config).toMatchObject({
			origins: ["https://example.com"],
			rpId: "example.com",
			rpName: "creating space",
			databasePath: "data/passkeys.sqlite",
			sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
			secureCookies: true,
			clientIpHeader: "x-forwarded-for",
			xffDepth: 1,
		});
	});

	it("defaults to localhost:3000 in development", () => {
		const devConfig = parseConfig({}, { dev: true });
		expect(devConfig.origins).toEqual(["http://localhost:3000"]);
		expect(devConfig.secureCookies).toBe(false);
	});

	it("accepts a parent domain as RP ID for several subdomains", () => {
		const config = parseConfig({
			PASSKEY_ORIGIN: "https://app.example.com, https://www.example.com",
			PASSKEY_RP_ID: "example.com",
		});
		expect(config.rpId).toBe("example.com");
		expect(config.origins).toHaveLength(2);
	});

	it("refuses to start without an origin in production", () => {
		expect(problemsOf({})[0]).toMatch(/PASSKEY_ORIGIN/);
	});

	it("rejects insecure origins, paths and foreign RP IDs, reporting all at once", () => {
		expect(problemsOf({ PASSKEY_ORIGIN: "http://example.com" })[0]).toMatch(
			/not a secure context/,
		);
		expect(
			problemsOf({ PASSKEY_ORIGIN: "https://example.com/app" })[0],
		).toMatch(/no path/);
		const problems = problemsOf({
			PASSKEY_ORIGIN: "https://example.com",
			PASSKEY_RP_ID: "other.org",
			SESSION_TTL_DAYS: "0",
		});
		expect(problems).toHaveLength(2);
		expect(problems[0]).toMatch(/neither example\.com nor a parent/);
		expect(problems[1]).toMatch(/SESSION_TTL_DAYS/);
	});

	it("rejects an origin list with no origins in it", () => {
		expect(problemsOf({ PASSKEY_ORIGIN: " , " })[0]).toMatch(/lists no origin/);
	});

	it("reads the client address from a configurable header", () => {
		const config = parseConfig({
			PASSKEY_ORIGIN: "https://example.com",
			PASSKEY_CLIENT_IP_HEADER: "X-Real-IP",
			PASSKEY_XFF_DEPTH: "2",
		});
		expect(config.clientIpHeader).toBe("x-real-ip");
		expect(config.xffDepth).toBe(2);
		expect(
			problemsOf({
				PASSKEY_ORIGIN: "https://example.com",
				PASSKEY_CLIENT_IP_HEADER: "x real ip",
				PASSKEY_XFF_DEPTH: "0",
			}),
		).toHaveLength(2);
	});

	it("rejects an IP address as RP ID", () => {
		expect(
			problemsOf({ PASSKEY_ORIGIN: "https://127.0.0.1" }).join(" "),
		).toMatch(/must be a domain/);
	});
});
