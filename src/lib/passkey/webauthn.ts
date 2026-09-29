/**
 * The browser half of the passkey ceremonies: capability checks, converting the
 * relying party's JSON options for `navigator.credentials`, and serializing the
 * result back to JSON. Nothing here decides whether a credential is valid.
 */
import { fromBase64Url, toBase64Url } from "./encoding";
import type {
	AuthenticationResponseJSON,
	RegistrationResponseJSON,
} from "./types";

/** Newer statics are missing in many browsers, so each one is optional at runtime. */
interface PublicKeyCredentialStatics {
	isUserVerifyingPlatformAuthenticatorAvailable?(): Promise<boolean>;
	getClientCapabilities?(): Promise<Record<string, boolean>>;
	parseCreationOptionsFromJSON?(
		options: PublicKeyCredentialCreationOptionsJSON,
	): PublicKeyCredentialCreationOptions;
	parseRequestOptionsFromJSON?(
		options: PublicKeyCredentialRequestOptionsJSON,
	): PublicKeyCredentialRequestOptions;
	signalUnknownCredential?(options: {
		rpId: string;
		credentialId: string;
	}): Promise<void>;
}

const statics = (): PublicKeyCredentialStatics | undefined =>
	typeof window !== "undefined" && "PublicKeyCredential" in window
		? (window.PublicKeyCredential as unknown as PublicKeyCredentialStatics)
		: undefined;

/**
 * How long a capability query may take. Some in-app browsers (the ones
 * Telegram or Instagram open links in, for example) return a promise from
 * these queries that never settles; waiting for it would keep the page
 * blank forever.
 */
const QUERY_TIMEOUT_MS = 1_000;

/**
 * A missing, throwing or hanging method reads as "not supported", never as
 * an error.
 */
const attempt = async <T>(
	query: () => Promise<T> | undefined,
): Promise<T | undefined> => {
	let timer: number | undefined;
	try {
		return await Promise.race([
			query(),
			new Promise<undefined>((resolve) => {
				timer = window.setTimeout(() => resolve(undefined), QUERY_TIMEOUT_MS);
			}),
		]);
	} catch {
		return undefined;
	} finally {
		window.clearTimeout(timer);
	}
};

export interface Capabilities {
	secureContext: boolean;
	webauthn: boolean;
	/** A built-in authenticator such as Touch ID, Windows Hello or an Android screen lock. */
	platformAuthenticator: boolean;
}

export const detectCapabilities = async (): Promise<Capabilities> => {
	const credential = statics();
	const secureContext = window.isSecureContext;
	if (!credential || !("credentials" in navigator)) {
		return { secureContext, webauthn: false, platformAuthenticator: false };
	}
	const client = await attempt(() => credential.getClientCapabilities?.());
	const platformAuthenticator =
		client?.userVerifyingPlatformAuthenticator ??
		(await attempt(() =>
			credential.isUserVerifyingPlatformAuthenticatorAvailable?.(),
		)) ??
		false;
	return { secureContext, webauthn: true, platformAuthenticator };
};

const toDescriptor = (
	descriptor: PublicKeyCredentialDescriptorJSON,
): PublicKeyCredentialDescriptor => ({
	type: "public-key",
	id: fromBase64Url(descriptor.id),
	transports: descriptor.transports as AuthenticatorTransport[] | undefined,
});

/** The manual fallbacks drop `extensions` and `hints`: none are requested, and extension inputs may hold binary fields. */
const parseCreationOptions = (
	json: PublicKeyCredentialCreationOptionsJSON,
): PublicKeyCredentialCreationOptions => {
	const credential = statics();
	if (credential?.parseCreationOptionsFromJSON) {
		return credential.parseCreationOptionsFromJSON(json);
	}
	return {
		rp: json.rp,
		user: { ...json.user, id: fromBase64Url(json.user.id) },
		challenge: fromBase64Url(json.challenge),
		pubKeyCredParams: json.pubKeyCredParams,
		timeout: json.timeout,
		excludeCredentials: json.excludeCredentials?.map(toDescriptor),
		authenticatorSelection: json.authenticatorSelection,
		attestation: json.attestation as
			| AttestationConveyancePreference
			| undefined,
	};
};

const parseRequestOptions = (
	json: PublicKeyCredentialRequestOptionsJSON,
): PublicKeyCredentialRequestOptions => {
	const credential = statics();
	if (credential?.parseRequestOptionsFromJSON) {
		return credential.parseRequestOptionsFromJSON(json);
	}
	return {
		challenge: fromBase64Url(json.challenge),
		rpId: json.rpId,
		timeout: json.timeout,
		allowCredentials: json.allowCredentials?.map(toDescriptor),
		userVerification: json.userVerification as
			| UserVerificationRequirement
			| undefined,
	};
};

/** Password-manager extensions sometimes hand back credentials without `toJSON`. */
const hasToJSON = (credential: PublicKeyCredential): boolean =>
	typeof (credential as { toJSON?: unknown }).toJSON === "function";

const registrationToJSON = (
	credential: PublicKeyCredential,
): RegistrationResponseJSON => {
	if (hasToJSON(credential)) {
		return credential.toJSON() as RegistrationResponseJSON;
	}
	const response = credential.response as AuthenticatorAttestationResponse;
	const publicKey = response.getPublicKey?.();
	const authenticatorData = response.getAuthenticatorData?.();
	return {
		id: credential.id,
		rawId: toBase64Url(credential.rawId),
		type: credential.type,
		authenticatorAttachment: credential.authenticatorAttachment,
		clientExtensionResults: credential.getClientExtensionResults(),
		response: {
			clientDataJSON: toBase64Url(response.clientDataJSON),
			attestationObject: toBase64Url(response.attestationObject),
			authenticatorData: authenticatorData
				? toBase64Url(authenticatorData)
				: undefined,
			transports: response.getTransports?.() ?? [],
			publicKey: publicKey ? toBase64Url(publicKey) : undefined,
			publicKeyAlgorithm: response.getPublicKeyAlgorithm?.(),
		},
	};
};

const authenticationToJSON = (
	credential: PublicKeyCredential,
): AuthenticationResponseJSON => {
	if (hasToJSON(credential)) {
		return credential.toJSON() as AuthenticationResponseJSON;
	}
	const response = credential.response as AuthenticatorAssertionResponse;
	return {
		id: credential.id,
		rawId: toBase64Url(credential.rawId),
		type: credential.type,
		authenticatorAttachment: credential.authenticatorAttachment,
		clientExtensionResults: credential.getClientExtensionResults(),
		response: {
			clientDataJSON: toBase64Url(response.clientDataJSON),
			authenticatorData: toBase64Url(response.authenticatorData),
			signature: toBase64Url(response.signature),
			userHandle: response.userHandle
				? toBase64Url(response.userHandle)
				: undefined,
		},
	};
};

let pendingRequest: AbortController | null = null;

/** Cancels the pending WebAuthn request, if any; its promise rejects with an `AbortError`. */
export const abortPendingRequest = (): void => {
	pendingRequest?.abort(
		new DOMException("Replaced by another WebAuthn request.", "AbortError"),
	);
	pendingRequest = null;
};

/** Browsers allow one pending WebAuthn request, so each new one cancels the last. */
const nextSignal = (): AbortSignal => {
	abortPendingRequest();
	pendingRequest = new AbortController();
	return pendingRequest.signal;
};

const noCredential = () =>
	new DOMException(
		"The authenticator returned no credential.",
		"NotAllowedError",
	);

/** Call straight from a click handler: browsers require recent user activation for the prompt. */
export const createPasskey = async (
	options: PublicKeyCredentialCreationOptionsJSON,
): Promise<RegistrationResponseJSON> => {
	const publicKey = parseCreationOptions(options);
	const credential = await navigator.credentials.create({
		publicKey,
		signal: nextSignal(),
	});
	if (!credential) {
		throw noCredential();
	}
	return registrationToJSON(credential as PublicKeyCredential);
};

/** Opens the browser's passkey picker; like `createPasskey`, call it from a click handler. */
export const getPasskey = async (
	options: PublicKeyCredentialRequestOptionsJSON,
): Promise<AuthenticationResponseJSON> => {
	const publicKey = parseRequestOptions(options);
	const credential = await navigator.credentials.get({
		publicKey,
		signal: nextSignal(),
	});
	if (!credential) {
		throw noCredential();
	}
	return authenticationToJSON(credential as PublicKeyCredential);
};

/** Tells the password manager a passkey no longer works here, so it can hide it. */
export const signalUnknownCredential = async (
	rpId: string,
	credentialId: string,
): Promise<void> => {
	await attempt(() =>
		statics()?.signalUnknownCredential?.({ rpId, credentialId }),
	);
};
