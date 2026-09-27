/**
 * Security log — docs/passkey-backend-requirements.md BR-SEC-8.
 *
 * One JSON object per line on stdout, easy to grep or ship to a log service.
 * Never pass cookies, session tokens, challenges or whole credential payloads.
 */

export type SecurityEvent =
	| "registration"
	| "sign_in"
	| "sign_out"
	| "account_deleted"
	| "unknown_credential"
	| "counter_regression"
	| "request_rejected";

export type SecurityLog = (
	event: SecurityEvent,
	fields: Record<string, unknown>,
) => void;

/** Events that may indicate an attack or a broken authenticator. */
const WARNINGS = new Set<SecurityEvent>([
	"counter_regression",
	"request_rejected",
]);

export const consoleSecurityLog: SecurityLog = (event, fields) => {
	console.log(
		JSON.stringify({
			time: new Date().toISOString(),
			level: WARNINGS.has(event) ? "warn" : "info",
			event,
			...fields,
		}),
	);
};

/**
 * Library error messages can quote challenges or keys. Anything that looks
 * like a long base64url value is masked before it reaches the log (BR-CH-9).
 */
export const redact = (text: string): string =>
	text.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]");
