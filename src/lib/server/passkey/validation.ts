/**
 * Input validation — docs/passkey-backend-requirements.md BR-GEN-4, BR-REGV-1,
 * BR-AUTHV-1.
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
