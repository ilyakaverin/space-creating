/**
 * The user-facing flows of FR-TEST-4, through the real frontend and the real
 * backend (docs/passkey-backend-requirements.md BR-TEST-2).
 */
import { expect, openApp, queryDb, test, uniqueName } from "./fixtures";

test("sign up on /register, stay signed in across reloads, sign out and sign in on the home page", async ({
	app,
}) => {
	await app.goto();
	expect(await app.actions()).toEqual(["Sign in", "Sign up"]);
	await app.click("Sign up");
	expect(new URL(app.page.url()).pathname).toBe("/register");

	const name = await app.createAccount();
	expect(new URL(app.page.url()).pathname).toBe("/");
	expect(await app.signedInAs()).toBe(name);

	await app.page.reload();
	await app.settle();
	expect(await app.signedInAs()).toBe(name);

	await app.click("Sign out");
	expect(await app.signedInAs()).toBeNull();
	expect(await app.actions()).toEqual(["Sign in", "Sign up"]);

	// Straight from the home page: no username, the passkey says who you are.
	await app.click("Sign in");
	expect(new URL(app.page.url()).pathname).toBe("/");
	expect(await app.signedInAs()).toBe(name);

	// The browser stores nothing; the server's database holds the account.
	expect(await app.page.evaluate(() => localStorage.length)).toBe(0);
	const user = await app.currentUser();
	expect(user?.name).toBe(name);
	const stored = await queryDb<{
		transports: string[];
		last_used_at: Date | null;
	}>(
		"SELECT transports, last_used_at FROM credentials WHERE user_id = $1",
		user?.id,
	);
	expect(stored).toHaveLength(1);
	expect(stored[0].transports).toEqual(["internal"]);
	expect(stored[0].last_used_at).not.toBeNull();
});

test("nothing is shown until the session is known", async ({ app }) => {
	// Session requests wait at this gate, as they would on a slow cold start.
	let openGate = () => {};
	let gate = Promise.resolve();
	await app.page.route("**/api/passkey/session", async (route) => {
		await gate;
		await route.continue();
	});
	const loadWhileHeld = async () => {
		gate = new Promise<void>((resolve) => {
			openGate = resolve;
		});
		await Promise.all([
			app.page.waitForRequest("**/api/passkey/session"),
			app.page.goto("/"),
		]);
		// The page has hydrated and asked; it must not guess the answer.
		expect(await app.actions()).toEqual([]);
		expect(await app.signedInAs()).toBeNull();
		openGate();
		await app.settle();
	};

	await loadWhileHeld();
	expect(await app.actions()).toEqual(["Sign in", "Sign up"]);

	const name = await app.createAccount();
	await loadWhileHeld();
	expect(await app.signedInAs()).toBe(name);
	expect(await app.actions()).toEqual(["Sign out"]);
});

test("a slow start says Loading…, and a lost session request still shows the buttons", async ({
	app,
}) => {
	// Held for 3 s, like a cold server waking a sleeping database. The hint
	// appears after 1 s, so it is on screen for the last 2.
	await app.page.route("**/api/passkey/session", async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 3_000));
		await route.continue();
	});
	await app.page.goto("/");
	await expect(app.page.locator("section.passkey")).toContainText("Loading…");
	await app.settle();
	expect(await app.actions()).toEqual(["Sign in", "Sign up"]);
	expect(await app.message()).toBe("");

	await app.page.unroute("**/api/passkey/session");
	await app.page.route("**/api/passkey/session", (route) => route.abort());
	await app.goto();
	expect(await app.actions()).toEqual(["Sign in", "Sign up"]);
	expect(await app.message()).toBe(
		"Couldn't reach the server. Check your connection.",
	);
});

test("a session request that never answers is given up after 15 s", async ({
	app,
}) => {
	test.setTimeout(40_000);
	await app.page.route("**/api/passkey/session", () => {
		// Never answered.
	});
	await app.page.goto("/");
	await app.settle();
	expect(await app.actions()).toEqual(["Sign in", "Sign up"]);
	expect(await app.message()).toBe(
		"Couldn't reach the server. Check your connection.",
	);
});

test("a browser whose passkey checks never answer still gets the buttons", async ({
	app,
}) => {
	// Some in-app browsers return promises from these that never settle.
	await app.page.addInitScript(() => {
		const never = () => new Promise<boolean>(() => {});
		const statics = PublicKeyCredential as unknown as Record<string, unknown>;
		statics.isUserVerifyingPlatformAuthenticatorAvailable = never;
		statics.getClientCapabilities = never;
	});
	await app.goto();
	expect(await app.actions()).toEqual(["Sign in", "Sign up"]);
});

test("/register asks for a username; signed in, only sign-out is offered", async ({
	app,
}) => {
	await app.goto("/register");
	expect(
		await app.page
			.locator("section.passkey input")
			.evaluateAll((inputs) =>
				inputs.map((input) => input.getAttribute("name")),
			),
	).toEqual(["username"]);
	expect(await app.actions()).toEqual(["Sign up"]);

	await app.createAccount();
	expect(await app.actions()).toEqual(["Sign out"]);
	// Signed in, the register page has nothing to offer and sends you home.
	await app.page.goto("/register");
	await app.page.waitForURL("/");
	await app.settle();
	expect(await app.actions()).toEqual(["Sign out"]);
});

test("the site is no longer a PWA, and removes the service worker it used to install", async ({
	app,
}) => {
	await app.goto();
	expect(await app.page.locator('link[rel="manifest"]').count()).toBe(0);
	expect(
		await app.page.evaluate(
			async () => (await navigator.serviceWorker.getRegistrations()).length,
		),
	).toBe(0);

	// A browser that installed the old worker: caches it filled, and the
	// worker at /service-worker.js, which it will find updated on its next visit.
	const left = await app.page.evaluate(async () => {
		await (await caches.open("pages-v1")).put("/", new Response("old page"));
		await (await caches.open("static-v1")).put("/x.js", new Response("old"));
		await navigator.serviceWorker.register("/service-worker.js");
		for (let tries = 0; tries < 50; tries++) {
			const registrations = await navigator.serviceWorker.getRegistrations();
			if (registrations.length === 0) {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return {
			registrations: (await navigator.serviceWorker.getRegistrations()).length,
			caches: await caches.keys(),
		};
	});
	expect(left).toEqual({ registrations: 0, caches: [] });

	// And the page itself registers nothing again.
	await app.page.reload();
	await app.settle();
	expect(
		await app.page.evaluate(
			async () => (await navigator.serviceWorker.getRegistrations()).length,
		),
	).toBe(0);
});

test("the old /login address leads to the home page", async ({ app }) => {
	await app.page.goto("/login");
	await app.page.waitForURL("/");
	await app.settle();
	expect(await app.actions()).toEqual(["Sign in", "Sign up"]);
});

test("the same account never gets a second passkey on a device", async ({
	app,
}) => {
	const name = await app.createAccount();
	await app.click("Sign out");

	await app.createAccount(name);
	expect(await app.message()).toBe(
		"That username is taken. If it's yours, sign in on the home page.",
	);
	expect(new URL(app.page.url()).pathname).toBe("/register");
	expect(await app.credentials()).toHaveLength(1);
});

test("a taken username is refused before any authenticator prompt, whatever its case", async ({
	app,
	browser,
}) => {
	const name = await app.createAccount();

	const other = await openApp(browser);
	await other.createAccount(name.toUpperCase());
	expect(await other.message()).toBe(
		"That username is taken. If it's yours, sign in on the home page.",
	);
	expect(await other.credentials()).toHaveLength(0);
	await other.context.close();
});

test("a blank username is refused without a prompt", async ({ app }) => {
	await app.createAccount("   ");
	expect(await app.message()).toBe("Enter a username of up to 64 characters.");
	expect(await app.credentials()).toHaveLength(0);
	const [{ count }] = await queryDb<{ count: string }>(
		"SELECT count(*) FROM users WHERE name = $1",
		"",
	);
	expect(Number(count)).toBe(0);
});

test("signing in without a passkey shows the neutral message", async ({
	app,
}) => {
	await app.signIn();
	expect(await app.message()).toBe(
		"Sign-in was cancelled or didn't complete. Try again.",
	);
	expect(await app.actions()).toEqual(["Sign in", "Sign up"]);
});

test("a passkey deleted on the server is reported and hidden through the Signal API", async ({
	app,
}) => {
	await app.createAccount(uniqueName());
	const user = await app.currentUser();
	await app.click("Sign out");
	await queryDb("DELETE FROM credentials WHERE user_id = $1", user?.id);

	await app.signIn();
	expect(await app.message()).toBe(
		"That passkey isn't registered here any more.",
	);
	// The page called PublicKeyCredential.signalUnknownCredential(), and
	// Chromium removed the passkey from the authenticator.
	await expect.poll(() => app.credentials()).toHaveLength(0);
});
