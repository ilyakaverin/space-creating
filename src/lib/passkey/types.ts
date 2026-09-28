/**
 * The contract between the passkey UI and the relying party (the backend).
 * Every binary field is a base64url string, so the shapes travel as JSON.
 */

export interface User {
	/** The WebAuthn user handle, base64url. */
	id: string;
	/** The username. */
	name: string;
}

export interface RegistrationInput {
	userName: string;
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
	/** Creates the account with its passkey and signs it in. */
	verifyRegistration(credential: RegistrationResponseJSON): Promise<User>;
	/**
	 * Fresh options for every attempt: for the passkeys of `userName`, or,
	 * without one, for any passkey this device holds for the site. Rejects
	 * with `unknown_user` before any prompt if no account has that name.
	 */
	authenticationOptions(
		input?: Partial<RegistrationInput>,
	): Promise<PublicKeyCredentialRequestOptionsJSON>;
	/** Verifies the assertion and signs its user in. */
	verifyAuthentication(credential: AuthenticationResponseJSON): Promise<User>;
	/** The signed-in user, or null. */
	currentUser(): Promise<User | null>;
	signOut(): Promise<void>;
}
