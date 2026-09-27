/**
 * Backend configuration — docs/passkey-backend-requirements.md §2.2.
 *
 * `parseConfig` is a pure function of an environment object, so it can be
 * unit-tested; `runtime.ts` calls it once at startup with `process.env` and
 * the server refuses to start if it throws.
 */

export interface PasskeyConfig {
	/** Exact origins (scheme + host + port) the ceremonies may run on, e.g. "https://example.com". */
	origins: string[];
	/** Relying party ID: the domain every passkey is bound to. */
	rpId: string;
	/** Name some authenticators show next to the passkey. */
	rpName: string;
	/** SQLite file path, or ":memory:" in tests. */
	databasePath: string;
	sessionTtlMs: number;
	/**
	 * True when every origin is https. Cookies then get `Secure` and the
	 * `__Host-` prefix; over http://localhost in development they cannot.
	 */
	secureCookies: boolean;
	/** Lower-case request header the client's IP address is read from. */
	clientIpHeader: string;
	/**
	 * For X-Forwarded-For: which entry, counted from the right, is the
	 * client — the number of reverse proxies in front of the app.
	 */
	xffDepth: number;
}

/** Collects every problem at once, so one restart fixes the whole configuration. */
export class ConfigError extends Error {
	readonly problems: string[];

	constructor(problems: string[]) {
		super(`Invalid passkey backend configuration:\n- ${problems.join("\n- ")}`);
		this.name = "ConfigError";
		this.problems = problems;
	}
}

type Env = Record<string, string | undefined>;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RP_NAME = "creating space";
const DEFAULT_DATABASE_PATH = "data/passkeys.sqlite";
const DEFAULT_SESSION_TTL_DAYS = 30;
/** `next dev` serves on this port by default, so development works without any setup. */
const DEV_ORIGIN = "http://localhost:3000";
const DEFAULT_CLIENT_IP_HEADER = "x-forwarded-for";
/** An HTTP header name: letters, digits and a few symbols, no spaces or colons. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;

/**
 * WebAuthn only runs in a secure context: https everywhere, plain http only
 * on localhost. An origin must be just scheme + host + port, no path.
 */
const parseOrigin = (value: string, problems: string[]): URL | null => {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		problems.push(`"${value}" is not a URL.`);
		return null;
	}
	if (url.origin !== value) {
		problems.push(
			`"${value}" must be an origin such as https://example.com — no path or trailing slash.`,
		);
		return null;
	}
	const secure =
		url.protocol === "https:" ||
		(url.protocol === "http:" && url.hostname === "localhost");
	if (!secure) {
		problems.push(
			`"${value}" is not a secure context: WebAuthn needs https (plain http only works on localhost).`,
		);
		return null;
	}
	return url;
};

const isIpAddress = (host: string): boolean =>
	/^[\d.]+$/.test(host) || host.includes(":");

export const parseConfig = (
	env: Env,
	{ dev = false }: { dev?: boolean } = {},
): PasskeyConfig => {
	const problems: string[] = [];

	// Next.js cannot tell the public origin behind a proxy, so production must name it.
	const originList = env.PASSKEY_ORIGIN?.trim() || (dev ? DEV_ORIGIN : "");
	if (!originList) {
		problems.push(
			"Set PASSKEY_ORIGIN to the site's origin, e.g. https://example.com.",
		);
	}
	const entries = originList
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (originList && entries.length === 0) {
		problems.push(`PASSKEY_ORIGIN "${originList}" lists no origin.`);
	}
	const urls = entries
		.map((value) => parseOrigin(value, problems))
		.filter((url): url is URL => url !== null);

	// The RP ID defaults to the first origin's hostname — the usual single-domain setup.
	const rpId = (env.PASSKEY_RP_ID?.trim() || urls[0]?.hostname || "")
		.toLowerCase()
		.replace(/\.$/, "");
	if (rpId && isIpAddress(rpId)) {
		problems.push(
			`PASSKEY_RP_ID "${rpId}" must be a domain, not an IP address.`,
		);
	}
	// Browsers only accept an RP ID equal to the page's hostname or a parent of it
	// (FR-SEC-2). Whether a parent is registrable — "example.com" yes, "com" no —
	// needs the public suffix list; the browser rejects the latter anyway.
	for (const url of urls) {
		if (url.hostname !== rpId && !url.hostname.endsWith(`.${rpId}`)) {
			problems.push(
				`PASSKEY_RP_ID "${rpId}" is neither ${url.hostname} nor a parent domain of it.`,
			);
		}
	}

	const ttlText = env.SESSION_TTL_DAYS?.trim();
	const ttlDays = ttlText ? Number(ttlText) : DEFAULT_SESSION_TTL_DAYS;
	if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 365) {
		problems.push(
			`SESSION_TTL_DAYS must be a whole number of days from 1 to 365, got "${ttlText}".`,
		);
	}

	const clientIpHeader = (
		env.PASSKEY_CLIENT_IP_HEADER?.trim() || DEFAULT_CLIENT_IP_HEADER
	).toLowerCase();
	if (!HEADER_NAME.test(clientIpHeader)) {
		problems.push(
			`PASSKEY_CLIENT_IP_HEADER "${clientIpHeader}" is not a header name.`,
		);
	}
	const depthText = env.PASSKEY_XFF_DEPTH?.trim();
	const xffDepth = depthText ? Number(depthText) : 1;
	if (!Number.isInteger(xffDepth) || xffDepth < 1 || xffDepth > 10) {
		problems.push(
			`PASSKEY_XFF_DEPTH must be a whole number from 1 to 10, got "${depthText}".`,
		);
	}

	if (problems.length > 0) {
		throw new ConfigError(problems);
	}
	return {
		origins: urls.map((url) => url.origin),
		rpId,
		rpName: env.PASSKEY_RP_NAME?.trim() || DEFAULT_RP_NAME,
		databasePath: env.DATABASE_PATH?.trim() || DEFAULT_DATABASE_PATH,
		sessionTtlMs: ttlDays * DAY_MS,
		secureCookies: urls.every((url) => url.protocol === "https:"),
		clientIpHeader,
		xffDepth,
	};
};
