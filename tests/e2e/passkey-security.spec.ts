/**
 * Negative tests: requests an attacker or a broken client could send
 * (docs/passkey-backend-requirements.md BR-TEST-3). Expired challenges are
 * covered by the unit tests, which control the clock.
 */
import { request } from "@playwright/test";
import { BASE_URL } from "../../playwright.config";
import {
	SESSION_COOKIE,
	apiClient,
	expect,
	openApp,
	queryDb,
	test,
	uniqueName,
} from "./fixtures";

const VERIFY = "/authentication/verify";

/** Flips one bit in a base64url value. */
const tamper = (value: string): string => {
	const bytes = Buffer.from(value, "base64url");
	bytes[bytes.length - 1] ^= 1;
	return bytes.toString("base64url");
};

test("a replayed assertion is rejected", async ({ app }) => {
	await app.goto();
	await app.createAccount(uniqueName());
	await app.click("Sign out");

	const assertion = await app.freshAssertion();
	expect((await app.api(VERIFY, { body: assertion })).status).toBe(200);
	const replay = await app.api(VERIFY, { body: assertion });
	expect(replay.status).toBe(400);
	expect(replay.body?.code).toBe("verification_failed");
});

test("an assertion is only accepted from the browser that asked for its challenge", async ({
	app,
	browser,
}) => {
	await app.goto();
	await app.createAccount(uniqueName());
	await app.click("Sign out");
	const assertion = await app.freshAssertion();

	const other = await openApp(browser);
	await other.goto();
	const stolen = await other.api(VERIFY, { body: assertion });
	expect(stolen.status).toBe(400);
	expect(stolen.body?.code).toBe("verification_failed");
	await other.context.close();

	// The attempt from elsewhere did not use the challenge up for its owner.
	expect((await app.api(VERIFY, { body: assertion })).status).toBe(200);
});

test("a tampered signature is rejected", async ({ app }) => {
	await app.goto();
	await app.createAccount(uniqueName());
	await app.click("Sign out");

	const assertion = await app.freshAssertion();
	assertion.response.signature = tamper(assertion.response.signature);
	const result = await app.api(VERIFY, { body: assertion });
	expect(result.status).toBe(400);
	expect(result.body?.code).toBe("verification_failed");
	// Production answers do not reveal which check failed.
	expect(result.body?.message).toBe("Credential could not be verified.");
});

test("an assertion claiming another account's user handle is rejected", async ({
	app,
	browser,
}) => {
	const other = await openApp(browser);
	await other.goto();
	const otherName = uniqueName();
	await other.createAccount(otherName);
	await other.context.close();
	const [otherUser] = queryDb<{ id: string }>(
		"SELECT id FROM users WHERE name = ?",
		otherName,
	);

	await app.goto();
	await app.createAccount(uniqueName());
	await app.click("Sign out");
	const assertion = await app.freshAssertion();
	assertion.response.userHandle = otherUser.id;
	const result = await app.api(VERIFY, { body: assertion });
	expect(result.status).toBe(400);
	expect(result.body?.code).toBe("verification_failed");
});

test("a signature counter that goes backwards is rejected", async ({ app }) => {
	await app.goto();
	await app.createAccount(uniqueName());
	await app.click("Sign out");

	// The virtual authenticator counts: the second assertion carries a larger number.
	const older = await app.freshAssertion();
	const newer = await app.freshAssertion();
	expect((await app.api(VERIFY, { body: newer })).status).toBe(200);
	const result = await app.api(VERIFY, { body: older });
	expect(result.status).toBe(400);
	expect(result.body?.code).toBe("verification_failed");
});

test("requests that did not come from the page are refused", async () => {
	const client = await apiClient();
	const options = "/api/passkey/authentication/options";

	const foreign = await client.post(options, {
		headers: {
			origin: "https://evil.example",
			"content-type": "application/json",
		},
		data: {},
	});
	expect(foreign.status()).toBe(403);
	expect((await foreign.json()).code).toBe("forbidden_origin");

	const noOrigin = await client.post(options, {
		headers: { "content-type": "application/json" },
		data: {},
	});
	expect(noOrigin.status()).toBe(403);

	const plainText = await client.post(options, {
		headers: { origin: BASE_URL, "content-type": "text/plain" },
		data: {},
	});
	expect(plainText.status()).toBe(415);
	expect((await plainText.json()).code).toBe("unsupported_media_type");

	const huge = await client.post("/api/passkey/registration/options", {
		headers: { origin: BASE_URL, "content-type": "application/json" },
		data: { userName: "x", padding: "x".repeat(70_000) },
	});
	expect(huge.status()).toBe(413);

	const broken = await client.post(options, {
		headers: { origin: BASE_URL, "content-type": "application/json" },
		// A Buffer goes out as-is; Playwright would JSON-encode a string.
		data: Buffer.from("{not json"),
	});
	expect(broken.status()).toBe(400);
	expect((await broken.json()).code).toBe("invalid_request");

	const deleteAnonymous = await client.delete("/api/passkey/account", {
		headers: { origin: BASE_URL },
	});
	expect(deleteAnonymous.status()).toBe(401);
	expect((await deleteAnonymous.json()).code).toBe("not_signed_in");

	const session = await client.get("/api/passkey/session");
	expect(session.status()).toBe(200);
	expect(session.headers()["cache-control"]).toBe("no-store");
	expect(await session.json()).toEqual({ user: null });
	await client.dispose();
});

test("reading the session needs neither an Origin nor a client address", async () => {
	// No x-test-client-ip header: only the rate-limited ceremonies need the
	// address, so a proxy that drops the header must not break session lookups.
	const client = await request.newContext({ baseURL: BASE_URL });
	const get = await client.get("/api/passkey/session");
	expect(get.status()).toBe(200);
	expect(await get.json()).toEqual({ user: null });
	// HEAD is answered by the GET handler and, like GET, needs no Origin.
	expect((await client.head("/api/passkey/session")).status()).toBe(200);
	await client.dispose();
});

test("options endpoints are rate limited per client", async () => {
	const client = await apiClient();
	const post = () =>
		client.post("/api/passkey/authentication/options", {
			headers: { origin: BASE_URL, "content-type": "application/json" },
			data: {},
		});
	for (let index = 0; index < 30; index++) {
		expect((await post()).status()).toBe(200);
	}
	const limited = await post();
	expect(limited.status()).toBe(429);
	expect((await limited.json()).code).toBe("rate_limited");
	expect(Number(limited.headers()["retry-after"])).toBeGreaterThan(0);
	await client.dispose();
});

test("session and flow cookies carry the required attributes", async ({
	app,
}) => {
	await app.goto();
	const [optionsResponse, verifyResponse] = await Promise.all([
		app.page.waitForResponse((response) =>
			response.url().endsWith("/registration/options"),
		),
		app.page.waitForResponse((response) =>
			response.url().endsWith("/registration/verify"),
		),
		app.createAccount(uniqueName()),
	]);

	// http://localhost cannot use Secure / __Host-, so the unprefixed names are used here.
	const flowCookie = await optionsResponse.headerValue("set-cookie");
	expect(flowCookie).toMatch(/^passkey-flow=/);
	expect(flowCookie).toContain("HttpOnly");
	expect(flowCookie).toMatch(/SameSite=Strict/i);
	// Outlives its challenges, so a late answer can still be told "expired".
	expect(flowCookie).toContain("Max-Age=86400");

	const sessionCookie = await verifyResponse.headerValue("set-cookie");
	expect(sessionCookie).toMatch(
		new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43};`),
	);
	expect(sessionCookie).toContain("HttpOnly");
	expect(sessionCookie).toMatch(/SameSite=Lax/i);
	expect(sessionCookie).toContain("Path=/");
	expect(sessionCookie).toContain("Expires=");
});

test("signing out invalidates the session on the server, not just the cookie", async ({
	app,
}) => {
	await app.goto();
	await app.createAccount(uniqueName());
	const cookie = (await app.context.cookies()).find(
		(entry) => entry.name === SESSION_COOKIE,
	);
	expect(cookie).toBeDefined();
	await app.click("Sign out");

	const client = await apiClient({
		cookie: `${SESSION_COOKIE}=${cookie?.value}`,
	});
	const response = await client.get("/api/passkey/session");
	expect(await response.json()).toEqual({ user: null });
	await client.dispose();
});
