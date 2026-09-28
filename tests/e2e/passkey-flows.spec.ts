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

test("each new passkey creates its own account", async ({ app }) => {
	await app.goto();
	await app.createAccount();
	const first = await app.currentUser();
	await app.click("Sign out");
	await app.createAccount();
	const second = await app.currentUser();

	expect(second?.id).not.toBe(first?.id);
	expect(second?.name).not.toBe(first?.name);
	expect(await app.credentials()).toHaveLength(2);
	const users = await queryDb(
		"SELECT 1 FROM users WHERE id = ANY($1::text[])",
		[first?.id, second?.id],
	);
	expect(users).toHaveLength(2);
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
});
