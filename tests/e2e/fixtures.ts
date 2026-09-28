/**
 * Helpers for the passkey end-to-end tests: a browser page with a virtual
 * authenticator, shortcuts for the UI, raw API calls, and direct database
 * access for assertions about what the server stored.
 */
import { randomUUID } from "node:crypto";
import {
	type Browser,
	type BrowserContext,
	type CDPSession,
	type Page,
	test as base,
	request,
} from "@playwright/test";
import pg from "pg";
import { BASE_URL, E2E_DATABASE_URL } from "../../playwright.config";

/** Header the test server reads the client address from (see playwright.config.ts). */
const CLIENT_IP_HEADER = "x-test-client-ip";

/** Over http://localhost the session cookie cannot carry the __Host- prefix. */
export const SESSION_COOKIE = "passkey-session";

/** The names the backend generates for new accounts. */
export const GENERATED_NAME = /^Traveller [0-9A-Z]{6}$/;

/** Runs one statement on the test server's database. */
export const queryDb = async <T>(
	sql: string,
	...params: unknown[]
): Promise<T[]> => {
	const client = new pg.Client({ connectionString: E2E_DATABASE_URL });
	await client.connect();
	try {
		return (await client.query(sql, params)).rows as T[];
	} finally {
		await client.end();
	}
};

export interface ApiResult {
	status: number;
	body: { code?: string; message?: string; [key: string]: unknown } | null;
}

/** `PublicKeyCredential.toJSON()` of an assertion; tests tamper with its fields. */
export interface AssertionJSON {
	id: string;
	rawId: string;
	type: string;
	response: {
		clientDataJSON: string;
		authenticatorData: string;
		signature: string;
		userHandle?: string;
	};
	[key: string]: unknown;
}

export interface App {
	context: BrowserContext;
	page: Page;
	cdp: CDPSession;
	/** Passkeys currently held by the virtual authenticator. */
	credentials(): Promise<{ credentialId: string; signCount: number }[]>;
	goto(): Promise<void>;
	/** Waits until no ceremony is running. */
	settle(): Promise<void>;
	/** The status line under the buttons. */
	message(): Promise<string>;
	/** The account's generated name when signed in, otherwise null. */
	signedInAs(): Promise<string | null>;
	/** The signed-in account as the API reports it. */
	currentUser(): Promise<{ id: string; name: string } | null>;
	/** Names of the buttons on show. */
	buttons(): Promise<string[]>;
	click(name: string): Promise<void>;
	createAccount(): Promise<void>;
	/** Calls the API from inside the page, so cookies and the Origin header are real. */
	api(
		path: string,
		init?: { method?: string; body?: unknown },
	): Promise<ApiResult>;
	/** Runs a sign-in ceremony in the page and returns the assertion without sending it. */
	freshAssertion(): Promise<AssertionJSON>;
}

export const openApp = async (browser: Browser): Promise<App> => {
	const context = await browser.newContext({
		baseURL: BASE_URL,
		serviceWorkers: "block",
		extraHTTPHeaders: { [CLIENT_IP_HEADER]: randomUUID() },
	});
	const page = await context.newPage();
	const cdp = await context.newCDPSession(page);
	await cdp.send("WebAuthn.enable");
	const { authenticatorId } = await cdp.send(
		"WebAuthn.addVirtualAuthenticator",
		{
			options: {
				protocol: "ctap2",
				transport: "internal",
				hasResidentKey: true,
				hasUserVerification: true,
				isUserVerified: true,
				automaticPresenceSimulation: true,
			},
		},
	);

	const section = page.locator("section.passkey");
	const settle = async () => {
		await page.waitForFunction(
			() =>
				document.querySelector("section.passkey")?.getAttribute("aria-busy") ===
				"false",
		);
		await page.waitForTimeout(100);
	};
	const click = async (name: string) => {
		await page.getByRole("button", { name }).click();
		await settle();
	};

	const api: App["api"] = (path, init = {}) =>
		page.evaluate(
			async ({ path, method, body }) => {
				const response = await fetch(`/api/passkey${path}`, {
					method,
					headers:
						body === undefined ? {} : { "Content-Type": "application/json" },
					body: body === undefined ? undefined : JSON.stringify(body),
				});
				const text = await response.text();
				return {
					status: response.status,
					body: text ? JSON.parse(text) : null,
				};
			},
			{ path, method: init.method ?? "POST", body: init.body },
		);

	return {
		context,
		page,
		cdp,
		credentials: async () =>
			(await cdp.send("WebAuthn.getCredentials", { authenticatorId }))
				.credentials,
		goto: async () => {
			await page.goto("/");
			await settle();
		},
		settle,
		message: async () =>
			(await section.locator("p.message[aria-live]").innerText()).trim(),
		signedInAs: async () =>
			(await section.innerText()).match(/Signed in as (.*)/)?.[1] ?? null,
		currentUser: async () =>
			(await api("/session", { method: "GET" })).body?.user as {
				id: string;
				name: string;
			} | null,
		buttons: () => section.getByRole("button").allInnerTexts(),
		click,
		createAccount: () => click("Create a passkey"),
		api,
		freshAssertion: () =>
			page.evaluate(async () => {
				const response = await fetch("/api/passkey/authentication/options", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: "{}",
				});
				const options = PublicKeyCredential.parseRequestOptionsFromJSON(
					await response.json(),
				);
				const credential = (await navigator.credentials.get({
					publicKey: options,
				})) as PublicKeyCredential;
				return credential.toJSON();
			}),
	};
};

/** An HTTP client outside any browser, with its own client address. */
export const apiClient = (headers: Record<string, string> = {}) =>
	request.newContext({
		baseURL: BASE_URL,
		extraHTTPHeaders: { [CLIENT_IP_HEADER]: randomUUID(), ...headers },
	});

export const test = base.extend<{ app: App }>({
	app: async ({ browser }, use) => {
		const app = await openApp(browser);
		await use(app);
		await app.context.close();
	},
});

export { expect } from "@playwright/test";
