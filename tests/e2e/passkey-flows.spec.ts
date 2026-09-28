/**
 * The user-facing flows of FR-TEST-4, through the real frontend and the real
 * backend (docs/passkey-backend-requirements.md BR-TEST-2).
 */
import { GENERATED_NAME, expect, queryDb, test } from "./fixtures";

test("register, stay signed in across reloads, sign out and sign in again", async ({
	app,
}) => {
	await app.goto();
	await app.createAccount();
	expect(await app.message()).toBe("Passkey created — you're signed in.");
	const name = await app.signedInAs();
	expect(name).toMatch(GENERATED_NAME);

	await app.page.reload();
	await app.settle();
	expect(await app.signedInAs()).toBe(name);

	await app.click("Sign out");
	expect(await app.signedInAs()).toBeNull();
	expect(await app.buttons()).toEqual(["Sign in with a passkey"]);
	await app.click("Sign in with a passkey");
	expect(await app.message()).toBe("Signed in with your passkey.");
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
		expect(await app.buttons()).toEqual([]);
		expect(await app.signedInAs()).toBeNull();
		openGate();
		await app.settle();
	};

	await loadWhileHeld();
	expect(await app.buttons()).toEqual([
		"Create a passkey",
		"Sign in with a passkey",
	]);

	await app.createAccount();
	const name = await app.signedInAs();
	await loadWhileHeld();
	expect(await app.signedInAs()).toBe(name);
	expect(await app.buttons()).toEqual(["Sign out"]);
});

test("signing up asks for no name, and a signed-in user can only sign out", async ({
	app,
}) => {
	await app.goto();
	expect(await app.page.locator("section.passkey input").count()).toBe(0);
	expect(await app.buttons()).toEqual([
		"Create a passkey",
		"Sign in with a passkey",
	]);

	await app.createAccount();
	expect(await app.buttons()).toEqual(["Sign out"]);
});

test("one passkey per device: once it has one, only sign-in is offered", async ({
	app,
}) => {
	await app.goto();
	await app.createAccount();
	const user = await app.currentUser();
	await app.click("Sign out");
	expect(await app.buttons()).toEqual(["Sign in with a passkey"]);
	await app.page.reload();
	await app.settle();
	expect(await app.buttons()).toEqual(["Sign in with a passkey"]);

	// The registration options ask the authenticator to refuse a duplicate.
	const [stored] = await queryDb<{ id: string }>(
		"SELECT id FROM credentials WHERE user_id = $1",
		user?.id,
	);
	const options = await app.api("/registration/options", { body: {} });
	expect(options.body?.excludeCredentials).toEqual([
		{ id: stored.id, type: "public-key", transports: ["internal"] },
	]);
});

test("the authenticator refuses a second passkey on the same device", async ({
	app,
}) => {
	await app.goto();
	await app.createAccount();
	await app.click("Sign out");

	// A failed sign-in brings "Create a passkey" back, below the sign-in button.
	await app.page.route(
		"**/api/passkey/authentication/options",
		(route) => route.fulfill({ status: 503 }),
		{ times: 1 },
	);
	await app.click("Sign in with a passkey");
	expect(await app.buttons()).toEqual([
		"Sign in with a passkey",
		"Create a passkey",
	]);

	await app.click("Create a passkey");
	expect(await app.message()).toBe(
		"This device already has a passkey here. Sign in with it instead.",
	);
	expect(await app.buttons()).toEqual(["Sign in with a passkey"]);
	expect(await app.credentials()).toHaveLength(1);

	await app.click("Sign in with a passkey");
	expect(await app.message()).toBe("Signed in with your passkey.");
});

test("a device whose passkey is gone can create a new one", async ({ app }) => {
	await app.goto();
	await app.createAccount();
	const first = await app.currentUser();
	await app.click("Sign out");
	// The user deleted the passkey in their password manager.
	await app.clearAuthenticator();

	await app.click("Sign in with a passkey");
	expect(await app.message()).toBe(
		"Sign-in was cancelled or didn't complete. Try again.",
	);
	await app.click("Create a passkey");
	expect(await app.message()).toBe("Passkey created — you're signed in.");
	const second = await app.currentUser();
	expect(second?.id).not.toBe(first?.id);
	expect(second?.name).not.toBe(first?.name);
	expect(await app.credentials()).toHaveLength(1);
});

test("signing in without a passkey shows the neutral message", async ({
	app,
}) => {
	await app.goto();
	await app.click("Sign in with a passkey");
	expect(await app.message()).toBe(
		"Sign-in was cancelled or didn't complete. Try again.",
	);
});

test("a passkey deleted on the server is reported and hidden through the Signal API", async ({
	app,
}) => {
	await app.goto();
	await app.createAccount();
	const user = await app.currentUser();
	await app.click("Sign out");
	await queryDb("DELETE FROM credentials WHERE user_id = $1", user?.id);

	await app.click("Sign in with a passkey");
	expect(await app.message()).toBe(
		"That passkey isn't registered here any more.",
	);
	// The page called PublicKeyCredential.signalUnknownCredential(), and
	// Chromium removed the passkey from the authenticator.
	await expect.poll(() => app.credentials()).toHaveLength(0);

	// A passkey that no longer exists does not count against the device:
	// the options exclude nothing, and the browser forgets it.
	const options = await app.api("/registration/options", { body: {} });
	expect(options.body?.excludeCredentials).toEqual([]);
	expect(
		(await app.context.cookies()).some(({ name }) => name === "passkey-device"),
	).toBe(false);
	await app.click("Create a passkey");
	expect(await app.message()).toBe("Passkey created — you're signed in.");
});
