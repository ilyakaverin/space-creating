/**
 * One passkey per device — docs/passkey-backend-requirements.md BR-REGO-9.
 *
 * WebAuthn lets no site ask a device which passkeys it holds: only an
 * authenticator shown a credential ID can answer "I already have that one"
 * (`excludeCredentials`). Without usernames the server cannot tell whose
 * device it is talking to, so the browser keeps the IDs of the passkeys it
 * created or signed in with, in a cookie (cookies.ts). These helpers read
 * and update that list.
 */

/** Newest first. A browser rarely has more than one; the cap keeps the cookie small. */
export const MAX_DEVICE_CREDENTIALS = 5;
/** Browsers drop cookies over 4 KiB; this leaves room for the name and attributes. */
const MAX_VALUE_LENGTH = 3_000;
/** A credential ID is at most 1023 bytes: 1364 base64url characters. */
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{1,1364}$/;
/** base64url never contains a dot. */
const SEPARATOR = ".";

/** The cookie comes from the client: anything malformed is dropped, not trusted. */
export const parseDeviceCredentials = (value: string | undefined): string[] =>
	[
		...new Set(
			(value ?? "").split(SEPARATOR).filter((id) => CREDENTIAL_ID.test(id)),
		),
	].slice(0, MAX_DEVICE_CREDENTIALS);

/** The cookie value; the oldest IDs go first if the value would get too long. */
export const serializeDeviceCredentials = (ids: string[]): string => {
	const kept = ids.slice(0, MAX_DEVICE_CREDENTIALS);
	while (kept.join(SEPARATOR).length > MAX_VALUE_LENGTH) {
		kept.pop();
	}
	return kept.join(SEPARATOR);
};

/** Puts a credential first, without duplicates. */
export const withDeviceCredential = (ids: string[], id: string): string[] =>
	[id, ...ids.filter((known) => known !== id)].slice(0, MAX_DEVICE_CREDENTIALS);
