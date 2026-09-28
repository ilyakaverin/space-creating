/**
 * The user-facing flows of FR-TEST-4, through the real frontend and the real
 * backend (docs/passkey-backend-requirements.md BR-TEST-2).
 */
import { expect, openApp, queryDb, test, uniqueName } from "./fixtures";

test("register on the login page, stay signed in across reloads, sign out and sign in again", async ({
	app,
}) => {
	await app.goto();
	expect(await app.actions()).toEqual(["Log in"]);
	await app.click("Log in");
	expect(new URL(app.page.url()).pathname).toBe("/login");

	const name = await app.createAccount();
	expect(new URL(app.page.url()).pathname).toBe("/");
	expect(await app.signedInAs()).toBe(name);

	await app.page.reload();
	await app.settle();
	expect(await app.signedInAs()).toBe(name);

	await app.click("Sign out");
	expect(await app.signedInAs()).toBeNull();
	expect(await app.actions()).toEqual(["Log in"]);

	await app.signIn();
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
	expect(await app.actions()).toEqual(["Log in"]);

	const name = await app.createAccount();
	await loadWhileHeld();
	expect(await app.signedInAs()).toBe(name);
	expect(await app.actions()).toEqual(["Sign out"]);
});

test("the login page asks for a username; signed in, only sign-out is offered", async ({
	app,
}) => {
	await app.goto("/login");
	expect(
		await app.page
			.locator("section.passkey input")
			.evaluateAll((inputs) =>
				inputs.map((input) => input.getAttribute("name")),
			),
	).toEqual(["username"]);
	expect(await app.actions()).toEqual(["Sign in", "Sign up"]);

	await app.createAccount();
	expect(await app.actions()).toEqual(["Sign out"]);
	// Signed in, the login page has nothing to offer and sends you home.
	await app.page.goto("/login");
	await app.page.waitForURL("/");
	await app.settle();
	expect(await app.actions()).toEqual(["Sign out"]);
});

test("signing in with a username offers only that account's passkey", async ({
	app,
}) => {
	const first = await app.createAccount();
	await app.click("Sign out");
	const second = await app.createAccount();
	await app.click("Sign out");
	expect(await app.credentials()).toHaveLength(2);

	for (const name of [first, second, first.toUpperCase()]) {
		await app.signIn(name);
		expect(await app.signedInAs()).toBe(name === second ? second : first);
		await app.click("Sign out");
	}
});

test("signing in with an unknown username says so before any prompt", async ({
	app,
}) => {
	await app.createAccount();
	await app.click("Sign out");
	await app.goto("/login");
	// Counts the WebAuthn prompts the page opens from here on.
	await app.page.evaluate(() => {
		const page = window as unknown as { prompts: number };
		page.prompts = 0;
		const get = navigator.credentials.get.bind(navigator.credentials);
		navigator.credentials.get = (options) => {
			page.prompts += 1;
			return get(options);
		};
	});
	await app.page.fill('input[name="username"]', "nobody-here");
	await app.click("Sign in");
	expect(await app.message()).toBe(
		"No account has that username. Sign up to create one.",
	);
	expect(
		await app.page.evaluate(
			() => (window as unknown as { prompts: number }).prompts,
		),
	).toBe(0);
	expect(new URL(app.page.url()).pathname).toBe("/login");
});

test("the same account never gets a second passkey on a device", async ({
	app,
}) => {
	const name = await app.createAccount();
	await app.click("Sign out");

	await app.createAccount(name);
	expect(await app.message()).toBe(
		"That username is taken. If it's yours, sign in with its passkey.",
	);
	expect(new URL(app.page.url()).pathname).toBe("/login");
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
		"That username is taken. If it's yours, sign in with its passkey.",
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
	expect(new URL(app.page.url()).pathname).toBe("/login");
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
