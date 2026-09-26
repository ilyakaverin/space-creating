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
import Database from "better-sqlite3";
import { BASE_URL } from "../../playwright.config";

/** Header the test server reads the client address from (see playwright.config.ts). */
const CLIENT_IP_HEADER = "x-test-client-ip";

export const uniqueName = (): string => `user-${randomUUID().slice(0, 8)}`;

/** Opens the test database; close it after use. */
export const openDb = () => {
	const path = process.env.E2E_DATABASE_PATH;
	if (!path) {
		throw new Error(
			"E2E_DATABASE_PATH is not set; run through playwright.config.ts.",
		);
	}
	const db = new Database(path);
	db.pragma("busy_timeout = 5000");
	return db;
};

export const queryDb = <T>(sql: string, ...params: unknown[]): T[] => {
	const db = openDb();
	try {
		return db.prepare(sql).all(...params) as T[];
	} finally {
		db.close();
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
	/** "Display name (username)" when signed in, otherwise null. */
	signedInAs(): Promise<string | null>;
	click(name: string): Promise<void>;
	createAccount(userName: string, displayName?: string): Promise<void>;
	/** Calls the API from inside the page, so cookies and the Origin header are real. */
	api(
		path: string,
		init?: { method?: string; body?: unknown },
	): Promise<ApiResult>;
	/** Runs a sign-in ceremony in the page and returns the assertion without sending it. */
	freshAssertion(): Promise<AssertionJSON>;
	/** Calls to navigator.credentials.get, with how each one ended. */
	getCalls(): Promise<{ mediation: string; outcome: string }[]>;
}

/**
 * Chromium's virtual authenticator answers a conditional (autofill) request
 * at once, which would sign the user back in right after every sign-out.
 * Real browsers keep it pending until the user picks a passkey, so by default
 * the tests do the same and only end it when the page aborts it.
 */
const initScript = ({ holdConditional }: { holdConditional: boolean }) => {
	const calls: { mediation: string; outcome: string }[] = [];
	(window as unknown as { __getCalls: typeof calls }).__getCalls = calls;
	const realGet = navigator.credentials.get.bind(navigator.credentials);
	navigator.credentials.get = (options?: CredentialRequestOptions) => {
		const call = {
			mediation: options?.mediation ?? "optional",
			outcome: "pending",
		};
		calls.push(call);
		if (options?.mediation === "conditional" && holdConditional) {
			return new Promise((_, reject) => {
				options.signal?.addEventListener("abort", () => {
					call.outcome = (options.signal?.reason as DOMException)?.name;
					reject(options.signal?.reason);
				});
			});
		}
		return realGet(options).then(
			(credential) => {
				call.outcome = "resolved";
				return credential;
			},
			(error: DOMException) => {
				call.outcome = error.name;
				throw error;
			},
		);
	};
};

export const openApp = async (
	browser: Browser,
	{ holdConditional = true } = {},
): Promise<App> => {
	const context = await browser.newContext({
		baseURL: BASE_URL,
		serviceWorkers: "block",
		extraHTTPHeaders: { [CLIENT_IP_HEADER]: randomUUID() },
	});
	await context.addInitScript(initScript, { holdConditional });
	const page = await context.newPage();
	page.on("dialog", (dialog) => dialog.accept());
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
		click,
		createAccount: async (userName, displayName) => {
			await page.fill('input[name="username"]', userName);
			await page.fill('input[name="display-name"]', displayName ?? "");
			await click("Create a passkey");
		},
		api: (path, init = {}) =>
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
			),
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
		getCalls: () =>
			page.evaluate(
				() =>
					(
						window as unknown as {
							__getCalls: { mediation: string; outcome: string }[];
						}
					).__getCalls,
			),
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
