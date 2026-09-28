import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "./config";

/** Every configuration needs a database; the tests below are about the rest. */
const DB = { DATABASE_URL: "postgresql://user:secret@db.example.com/app" };

const problemsOf = (
	env: Record<string, string>,
	options?: { dev?: boolean },
): string[] => {
	try {
		parseConfig(env, options);
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
		const config = parseConfig({
			...DB,
			PASSKEY_ORIGIN: "https://example.com",
		});
		expect(config).toEqual({
			origins: ["https://example.com"],
			rpId: "example.com",
			rpName: "creating space",
			databaseUrl: DB.DATABASE_URL,
			sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
			secureCookies: true,
			clientIpHeader: "x-forwarded-for",
			xffDepth: 1,
		});
	});

	it("defaults to localhost:3000 in development", () => {
		const devConfig = parseConfig(DB, { dev: true });
		expect(devConfig.origins).toEqual(["http://localhost:3000"]);
		expect(devConfig.secureCookies).toBe(false);
	});

	it("takes the origin from Vercel's variables when PASSKEY_ORIGIN is unset", () => {
		const vercel = {
			...DB,
			VERCEL_PROJECT_PRODUCTION_URL: "space.example.com",
			VERCEL_BRANCH_URL: "space-git-feature-team.vercel.app",
			VERCEL_URL: "space-abc123-team.vercel.app",
		};
		expect(
			parseConfig({ ...vercel, VERCEL_ENV: "production" }).origins,
		).toEqual(["https://space.example.com"]);
		expect(parseConfig({ ...vercel, VERCEL_ENV: "preview" })).toMatchObject({
			origins: ["https://space-git-feature-team.vercel.app"],
			rpId: "space-git-feature-team.vercel.app",
		});
		// `vercel env pull` writes these, empty, for development.
		expect(
			parseConfig(
				{ ...DB, VERCEL_ENV: "development", VERCEL_URL: "" },
				{ dev: true },
			).origins,
		).toEqual(["http://localhost:3000"]);
		// An explicit origin wins.
		expect(
			parseConfig({
				...vercel,
				VERCEL_ENV: "production",
				PASSKEY_ORIGIN: "https://www.example.com",
			}).origins,
		).toEqual(["https://www.example.com"]);
	});

	it("reads the database URL from DATABASE_URL or POSTGRES_URL, and never echoes it", () => {
		const origin = { PASSKEY_ORIGIN: "https://example.com" };
		expect(
			parseConfig({ ...origin, POSTGRES_URL: DB.DATABASE_URL }).databaseUrl,
		).toBe(DB.DATABASE_URL);
		expect(problemsOf(origin)[0]).toMatch(/Set DATABASE_URL/);
		const problems = problemsOf({
			...origin,
			DATABASE_URL: "mysql://user:secret@db.example.com/app",
		});
		expect(problems[0]).toMatch(/postgresql:\/\//);
		expect(problems.join(" ")).not.toContain("secret");
	});

	it("accepts a parent domain as RP ID for several subdomains", () => {
		const config = parseConfig({
			...DB,
			PASSKEY_ORIGIN: "https://app.example.com, https://www.example.com",
			PASSKEY_RP_ID: "example.com",
		});
		expect(config.rpId).toBe("example.com");
		expect(config.origins).toHaveLength(2);
	});

	it("refuses to start without an origin in production", () => {
		expect(problemsOf(DB)[0]).toMatch(/PASSKEY_ORIGIN/);
	});

	it("rejects insecure origins, paths and foreign RP IDs, reporting all at once", () => {
		expect(
			problemsOf({ ...DB, PASSKEY_ORIGIN: "http://example.com" })[0],
		).toMatch(/not a secure context/);
		expect(
			problemsOf({ ...DB, PASSKEY_ORIGIN: "https://example.com/app" })[0],
		).toMatch(/no path/);
		const problems = problemsOf({
			PASSKEY_ORIGIN: "https://example.com",
			PASSKEY_RP_ID: "other.org",
			SESSION_TTL_DAYS: "0",
		});
		expect(problems).toHaveLength(3);
		expect(problems[0]).toMatch(/neither example\.com nor a parent/);
		expect(problems[1]).toMatch(/SESSION_TTL_DAYS/);
		expect(problems[2]).toMatch(/DATABASE_URL/);
	});

	it("rejects an origin list with no origins in it", () => {
		expect(problemsOf({ ...DB, PASSKEY_ORIGIN: " , " })[0]).toMatch(
			/lists no origin/,
		);
	});

	it("reads the client address from a configurable header", () => {
		const config = parseConfig({
			...DB,
			PASSKEY_ORIGIN: "https://example.com",
			PASSKEY_CLIENT_IP_HEADER: "X-Real-IP",
			PASSKEY_XFF_DEPTH: "2",
		});
		expect(config.clientIpHeader).toBe("x-real-ip");
		expect(config.xffDepth).toBe(2);
		expect(
			problemsOf({
				...DB,
				PASSKEY_ORIGIN: "https://example.com",
				PASSKEY_CLIENT_IP_HEADER: "x real ip",
				PASSKEY_XFF_DEPTH: "0",
			}),
		).toHaveLength(2);
	});

	it("rejects an IP address as RP ID", () => {
		expect(
			problemsOf({ ...DB, PASSKEY_ORIGIN: "https://127.0.0.1" }).join(" "),
		).toMatch(/must be a domain/);
	});
});
