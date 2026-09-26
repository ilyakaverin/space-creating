/**
 * Input validation — docs/passkey-backend-requirements.md BR-GEN-4, BR-REGO-1…3,
 * BR-REGV-1, BR-AUTHV-1.
 *
 * Everything from the network is `unknown` until it passes through here.
 * Validation runs before any database lookup or crypto, and only the fields
 * the backend actually uses survive into the typed result.
 */
import type {
	AuthenticationResponseJSON,
	RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { ApiError } from "./errors";

/** Authenticators may cut `user.name` and `user.displayName` beyond 64 bytes. */
const MAX_NAME_BYTES = 64;
const CONTROL_CHARACTER = /\p{Cc}/u;
/** Unpadded base64url (RFC 4648 §5): the only binary encoding the API accepts. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const KNOWN_TRANSPORTS = new Set([
	"usb",
	"nfc",
	"ble",
	"smart-card",
	"hybrid",
	"internal",
]);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const invalid = (message: string) => new ApiError("invalid_request", message);

const byteLength = (value: string): number =>
	new TextEncoder().encode(value).length;

/** The form names are compared in: NFC so é is one code point either way, then lower case. */
export const nameKey = (name: string): string =>
	name.normalize("NFC").toLowerCase();

export interface UserName {
	/** As typed (trimmed, NFC) — stored and shown. */
	name: string;
	/** Comparison form, unique across accounts. */
	key: string;
}

export const parseUserName = (value: unknown): UserName => {
	if (typeof value !== "string") {
		throw new ApiError("invalid_username", "userName must be a string.");
	}
	const name = value.normalize("NFC").trim();
	if (!name) {
		throw new ApiError("invalid_username", "userName is empty.");
	}
	if (byteLength(name) > MAX_NAME_BYTES) {
		throw new ApiError(
			"invalid_username",
			`userName is longer than ${MAX_NAME_BYTES} UTF-8 bytes.`,
		);
	}
	if (CONTROL_CHARACTER.test(name)) {
		throw new ApiError(
			"invalid_username",
			"userName contains control characters.",
		);
	}
	return { name, key: nameKey(name) };
};

/** Optional; an empty or missing display name falls back to the username. */
export const parseDisplayName = (value: unknown, fallback: string): string => {
	if (value === undefined || value === null) {
		return fallback;
	}
	if (typeof value !== "string") {
		throw invalid("displayName must be a string.");
	}
	const displayName = value.normalize("NFC").trim();
	if (byteLength(displayName) > MAX_NAME_BYTES) {
		throw invalid(`displayName is longer than ${MAX_NAME_BYTES} UTF-8 bytes.`);
	}
	if (CONTROL_CHARACTER.test(displayName)) {
		throw invalid("displayName contains control characters.");
	}
	return displayName || fallback;
};

const base64Url = (value: unknown, field: string): string => {
	if (typeof value !== "string" || !BASE64URL.test(value)) {
		throw invalid(`${field} must be a non-empty base64url string.`);
	}
	return value;
};

/** Unknown transports are dropped rather than rejected: new ones appear over time. */
const parseTransports = (value: unknown): string[] => {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value)) {
		throw invalid("response.transports must be an array.");
	}
	return [
		...new Set(
			value.filter(
				(item): item is string =>
					typeof item === "string" && KNOWN_TRANSPORTS.has(item),
			),
		),
	];
};

const parseAttachment = (
	value: unknown,
): RegistrationResponseJSON["authenticatorAttachment"] =>
	value === "platform" || value === "cross-platform" ? value : undefined;

/** Fields shared by both credential kinds: `id` and `rawId` must be the same base64url string. */
const parseCredentialEnvelope = (body: unknown) => {
	if (!isRecord(body) || !isRecord(body.response)) {
		throw invalid("Expected a PublicKeyCredential serialized with toJSON().");
	}
	const id = base64Url(body.id, "id");
	if (body.rawId !== id) {
		throw invalid("rawId must equal id.");
	}
	if (body.type !== "public-key") {
		throw invalid('type must be "public-key".');
	}
	return {
		id,
		rawId: id,
		type: "public-key" as const,
		authenticatorAttachment: parseAttachment(body.authenticatorAttachment),
		clientExtensionResults: isRecord(body.clientExtensionResults)
			? body.clientExtensionResults
			: {},
		response: body.response,
	};
};

/**
 * A registration credential. `authenticatorData`, `publicKey` and
 * `publicKeyAlgorithm` are deliberately dropped: the browser merely copied
 * them out of `attestationObject`, which is what gets verified (BR-REGV-1).
 */
export const parseRegistrationResponse = (
	body: unknown,
): RegistrationResponseJSON => {
	const { response, ...credential } = parseCredentialEnvelope(body);
	return {
		...credential,
		response: {
			clientDataJSON: base64Url(
				response.clientDataJSON,
				"response.clientDataJSON",
			),
			attestationObject: base64Url(
				response.attestationObject,
				"response.attestationObject",
			),
			transports: parseTransports(response.transports) as NonNullable<
				RegistrationResponseJSON["response"]["transports"]
			>,
		},
	};
};

/** An assertion. `userHandle` may be missing here; the ceremony rejects that with a clear reason. */
export const parseAuthenticationResponse = (
	body: unknown,
): AuthenticationResponseJSON => {
	const { response, ...credential } = parseCredentialEnvelope(body);
	return {
		...credential,
		response: {
			clientDataJSON: base64Url(
				response.clientDataJSON,
				"response.clientDataJSON",
			),
			authenticatorData: base64Url(
				response.authenticatorData,
				"response.authenticatorData",
			),
			signature: base64Url(response.signature, "response.signature"),
			userHandle:
				response.userHandle === undefined || response.userHandle === null
					? undefined
					: base64Url(response.userHandle, "response.userHandle"),
		},
	};
};

export interface ClientData {
	type: string;
	challenge: string;
	origin: string;
	crossOrigin?: boolean;
	topOrigin?: string;
}

/**
 * Decodes `clientDataJSON`, the JSON the browser builds and the authenticator
 * signs. The backend reads the challenge from it to find its stored record.
 */
export const decodeClientData = (clientDataJSON: string): ClientData => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(isoBase64URL.toUTF8String(clientDataJSON));
	} catch {
		throw invalid("response.clientDataJSON is not base64url-encoded JSON.");
	}
	if (
		!isRecord(parsed) ||
		typeof parsed.type !== "string" ||
		typeof parsed.challenge !== "string" ||
		typeof parsed.origin !== "string"
	) {
		throw invalid("response.clientDataJSON lacks type, challenge or origin.");
	}
	return parsed as unknown as ClientData;
};
