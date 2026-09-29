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
	await app.createAccount();
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
	await app.createAccount();
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
	await app.createAccount();
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
	await other.createAccount();
	const otherUser = await other.currentUser();
	await other.context.close();

	await app.goto();
	await app.createAccount();
	await app.click("Sign out");
	const assertion = await app.freshAssertion();
	assertion.response.userHandle = otherUser?.id;
	const result = await app.api(VERIFY, { body: assertion });
	expect(result.status).toBe(400);
	expect(result.body?.code).toBe("verification_failed");
});

test("sign-in options for a username list only its passkeys and refuse unknown names", async ({
	app,
}) => {
	const name = await app.createAccount();
	const user = await app.currentUser();
	const [stored] = await queryDb<{ id: string }>(
		"SELECT id FROM credentials WHERE user_id = $1",
		user?.id,
	);
	const client = await apiClient();
	const post = (data: unknown) =>
		client.post("/api/passkey/authentication/options", {
			headers: { origin: BASE_URL, "content-type": "application/json" },
			data,
		});

	const named = await post({ userName: name.toUpperCase() });
	expect(named.status()).toBe(200);
	expect((await named.json()).allowCredentials).toEqual([
		{ id: stored.id, type: "public-key", transports: ["internal"] },
	]);
	expect((await (await post({})).json()).allowCredentials).toEqual([]);
	const unknown = await post({ userName: "nobody-here" });
	expect(unknown.status()).toBe(404);
	expect((await unknown.json()).code).toBe("unknown_user");
	await client.dispose();
});

test("a sign-in for a typed username only accepts that account's passkey", async ({
	app,
	browser,
}) => {
	const other = await openApp(browser);
	const otherName = await other.createAccount();
	await other.context.close();

	await app.createAccount();
	await app.click("Sign out");
	// A modified client asks for the other account's options, then answers
	// the challenge with its own passkey instead of one allowCredentials names.
	const assertion = await app.page.evaluate(async (userName) => {
		const response = await fetch("/api/passkey/authentication/options", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ userName }),
		});
		const options = await response.json();
		const credential = (await navigator.credentials.get({
			publicKey: PublicKeyCredential.parseRequestOptionsFromJSON({
				...options,
				allowCredentials: [],
			}),
		})) as PublicKeyCredential;
		return credential.toJSON();
	}, otherName);
	const result = await app.api(VERIFY, { body: assertion });
	expect(result.status).toBe(400);
	expect(result.body?.code).toBe("verification_failed");
});

test("a signature counter that goes backwards is rejected", async ({ app }) => {
	await app.goto();
	await app.createAccount();
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
		data: { padding: "x".repeat(70_000) },
	});
	expect(huge.status()).toBe(413);

	const broken = await client.post(options, {
		headers: { origin: BASE_URL, "content-type": "application/json" },
		// A Buffer goes out as-is; Playwright would JSON-encode a string.
		data: Buffer.from("{not json"),
	});
	expect(broken.status()).toBe(400);
	expect((await broken.json()).code).toBe("invalid_request");

	const session = await client.get("/api/passkey/session");
	expect(session.status()).toBe(200);
	expect(session.headers()["cache-control"]).toBe("no-store");
	expect(await session.json()).toEqual({ user: null });
	await client.dispose();
});

test("registration options name the account as typed, with a random handle", async () => {
	const client = await apiClient();
	const post = (data: unknown) =>
		client.post("/api/passkey/registration/options", {
			headers: { origin: BASE_URL, "content-type": "application/json" },
			data,
		});
	const name = uniqueName();

	const response = await post({ userName: ` ${name} ` });
	expect(response.status()).toBe(200);
	const { user, excludeCredentials } = await response.json();
	expect(user.name).toBe(name);
	expect(user.displayName).toBe(name);
	// 32 random bytes: the user handle says nothing about the person.
	expect(Buffer.from(user.id, "base64url")).toHaveLength(32);
	expect(excludeCredentials).toEqual([]);

	for (const data of [{}, { userName: "" }, { userName: "x".repeat(65) }]) {
		const invalid = await post(data);
		expect(invalid.status()).toBe(400);
		expect((await invalid.json()).code).toBe("invalid_username");
	}
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
		app.createAccount(),
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
	await app.createAccount();
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
