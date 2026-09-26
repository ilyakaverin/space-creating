/**
 * The user-facing flows of FR-TEST-4, through the real frontend and the real
 * backend (docs/passkey-backend-requirements.md BR-TEST-2).
 */
import {
	apiClient,
	expect,
	openApp,
	queryDb,
	test,
	uniqueName,
} from "./fixtures";

test("register, stay signed in across reloads, sign out and sign in again", async ({
	app,
}) => {
	const name = uniqueName();
	await app.goto();
	await app.createAccount(name, "Test User");
	expect(await app.message()).toBe("Passkey created — you're signed in.");
	expect(await app.signedInAs()).toBe(`Test User (${name})`);

	await app.page.reload();
	await app.settle();
	expect(await app.signedInAs()).toBe(`Test User (${name})`);

	await app.click("Sign out");
	expect(await app.signedInAs()).toBeNull();
	await app.click("Sign in with a passkey");
	expect(await app.message()).toBe("Signed in with your passkey.");
	expect(await app.signedInAs()).toBe(`Test User (${name})`);

	// In backend mode the browser stores nothing; the server holds the passkey.
	expect(await app.page.evaluate(() => localStorage.length)).toBe(0);
	const stored = queryDb<{ transports: string; last_used_at: number | null }>(
		`SELECT c.transports, c.last_used_at FROM credentials c
		 JOIN users u ON u.id = c.user_id WHERE u.name = ?`,
		name,
	);
	expect(stored).toHaveLength(1);
	expect(JSON.parse(stored[0].transports)).toEqual(["internal"]);
	expect(stored[0].last_used_at).not.toBeNull();
});

test("adding a passkey on the same device is refused by excludeCredentials", async ({
	app,
}) => {
	const name = uniqueName();
	await app.goto();
	await app.createAccount(name);
	await app.click("Add a passkey");
	expect(await app.message()).toBe(
		"This device already has a passkey for your account.",
	);
	expect(await app.credentials()).toHaveLength(1);
	expect(
		queryDb(
			"SELECT 1 FROM credentials c JOIN users u ON u.id = c.user_id WHERE u.name = ?",
			name,
		),
	).toHaveLength(1);
});

test("a taken username is refused before any authenticator prompt", async ({
	app,
	browser,
}) => {
	const name = uniqueName();
	await app.goto();
	await app.createAccount(name);

	const other = await openApp(browser);
	await other.goto();
	await other.createAccount(name.toUpperCase());
	expect(await other.message()).toBe(
		"That username is taken. Pick another one.",
	);
	expect(await other.credentials()).toHaveLength(0);
	await other.context.close();
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
	const name = uniqueName();
	await app.goto();
	await app.createAccount(name);
	await app.click("Sign out");
	queryDb(
		"DELETE FROM credentials WHERE user_id = (SELECT id FROM users WHERE name = ?) RETURNING id",
		name,
	);

	await app.click("Sign in with a passkey");
	expect(await app.message()).toBe(
		"That passkey isn't registered here any more.",
	);
	// The page called PublicKeyCredential.signalUnknownCredential(), and
	// Chromium removed the passkey from the authenticator.
	await expect.poll(() => app.credentials()).toHaveLength(0);
});

test("the autofill request starts on load and is cancelled silently by other ceremonies", async ({
	app,
}) => {
	await app.goto();
	expect(await app.getCalls()).toEqual([
		{ mediation: "conditional", outcome: "pending" },
	]);
	await app.createAccount(uniqueName());
	expect(await app.message()).toBe("Passkey created — you're signed in.");
	expect((await app.getCalls())[0]).toEqual({
		mediation: "conditional",
		outcome: "AbortError",
	});
});

test("choosing the passkey from autofill signs in", async ({ browser }) => {
	// This time Chromium's own conditional request answers, as if the user
	// picked the passkey from the username field's suggestions.
	const app = await openApp(browser, { holdConditional: false });
	const name = uniqueName();
	await app.goto();
	await app.createAccount(name);
	await app.click("Sign out");
	await expect.poll(() => app.signedInAs()).toBe(name);
	expect(await app.message()).toBe("Signed in with your passkey.");
	await app.context.close();
});

test("deleting the account removes it everywhere and ends the session", async ({
	app,
}) => {
	const name = uniqueName();
	await app.goto();
	await app.createAccount(name);
	const [user] = queryDb<{ id: string }>(
		"SELECT id FROM users WHERE name = ?",
		name,
	);
	const cookie = (await app.context.cookies()).find(
		(entry) => entry.name === "session",
	);

	await app.click("Delete account");
	expect(await app.signedInAs()).toBeNull();
	for (const table of ["users", "credentials", "sessions"]) {
		const column = table === "users" ? "id" : "user_id";
		expect(
			queryDb(`SELECT 1 FROM ${table} WHERE ${column} = ?`, user.id),
		).toHaveLength(0);
	}

	// The old cookie no longer means anything to the server.
	const client = await apiClient({ cookie: `session=${cookie?.value}` });
	const response = await client.get("/api/passkey/session");
	expect(await response.json()).toEqual({ user: null });
	await client.dispose();
});
