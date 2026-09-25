/**
 * The contract between the passkey UI and a relying party. Every binary field is
 * a base64url string, so the same shapes work for the in-browser relying party
 * and for a backend reached over HTTP.
 */

export interface User {
	/** The WebAuthn user handle, base64url. */
	id: string;
	name: string;
	displayName: string;
}

export interface RegistrationInput {
	userName: string;
	displayName?: string;
}

/** `PublicKeyCredential.toJSON()` of a registration, per WebAuthn Level 3. */
export interface RegistrationResponseJSON {
	id: string;
	rawId: string;
	type: string;
	authenticatorAttachment?: string | null;
	clientExtensionResults: AuthenticationExtensionsClientOutputs;
	response: {
		clientDataJSON: string;
		attestationObject: string;
		authenticatorData?: string;
		transports?: string[];
		publicKey?: string;
		publicKeyAlgorithm?: number;
	};
}

/** `PublicKeyCredential.toJSON()` of an assertion, per WebAuthn Level 3. */
export interface AuthenticationResponseJSON {
	id: string;
	rawId: string;
	type: string;
	authenticatorAttachment?: string | null;
	clientExtensionResults: AuthenticationExtensionsClientOutputs;
	response: {
		clientDataJSON: string;
		authenticatorData: string;
		signature: string;
		userHandle?: string | null;
	};
}

export interface RelyingParty {
	/** Used for Signal API calls, which must name the RP ID the passkeys belong to. */
	readonly rpId: string;
	/** Fresh options for every attempt. Rejects with `username_taken` before any authenticator prompt. */
	registrationOptions(
		input: RegistrationInput,
	): Promise<PublicKeyCredentialCreationOptionsJSON>;
	/** Stores the new passkey and signs its user in. */
	verifyRegistration(credential: RegistrationResponseJSON): Promise<User>;
	/** Fresh options for every attempt, with an empty `allowCredentials` so any discoverable passkey can answer. */
	authenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON>;
	/** Verifies the assertion and signs its user in. */
	verifyAuthentication(credential: AuthenticationResponseJSON): Promise<User>;
	/** The signed-in user, or null. */
	currentUser(): Promise<User | null>;
	signOut(): Promise<void>;
	/** Removes the signed-in user and every passkey registered to them, then signs out. */
	deleteAccount(): Promise<void>;
}
