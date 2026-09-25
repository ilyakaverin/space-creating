/**
 * WebAuthn ceremonies for a static site: the relying party lives in the browser,
 * so the challenge, the credential and the verification all happen client side.
 * That makes this a demonstration of the passkey UX, not an authentication
 * boundary — a real deployment must issue challenges and verify assertions on a
 * server the client cannot tamper with.
 */

const STORAGE_KEY = "space-creating:passkey";
const RP_NAME = "creating space";
const ES256 = -7;
const RS256 = -257;

export interface StoredPasskey {
	credentialId: string;
	publicKey: string | null;
	algorithm: number | null;
	userName: string;
	createdAt: number;
}

export interface SignInResult {
	userName: string;
	signatureVerified: boolean;
}

const toBase64Url = (bytes: ArrayBuffer): string => {
	let binary = "";
	for (const byte of new Uint8Array(bytes)) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
};

const fromBase64Url = (value: string): Uint8Array => {
	const padded = value
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");
	const binary = atob(padded);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

const randomBytes = (length: number): Uint8Array =>
	crypto.getRandomValues(new Uint8Array(length));

export const isPasskeySupported = (): boolean =>
	typeof window !== "undefined" &&
	"PublicKeyCredential" in window &&
	"credentials" in navigator;

export const loadPasskey = (): StoredPasskey | null => {
	const raw = localStorage.getItem(STORAGE_KEY);
	if (!raw) {
		return null;
	}
	try {
		return JSON.parse(raw) as StoredPasskey;
	} catch {
		localStorage.removeItem(STORAGE_KEY);
		return null;
	}
};

export const forgetPasskey = (): void => localStorage.removeItem(STORAGE_KEY);

export const createPasskey = async (
	userName: string,
): Promise<StoredPasskey> => {
	const challenge = randomBytes(32);
	const credential = (await navigator.credentials.create({
		publicKey: {
			challenge,
			rp: { name: RP_NAME, id: location.hostname },
			user: { id: randomBytes(16), name: userName, displayName: userName },
			pubKeyCredParams: [
				{ type: "public-key", alg: ES256 },
				{ type: "public-key", alg: RS256 },
			],
			authenticatorSelection: {
				residentKey: "preferred",
				userVerification: "preferred",
			},
			timeout: 60_000,
		},
	})) as PublicKeyCredential | null;

	if (!credential) {
		throw new Error("The authenticator did not return a credential.");
	}

	const response = credential.response as AuthenticatorAttestationResponse;
	const publicKey = response.getPublicKey();
	const passkey: StoredPasskey = {
		credentialId: toBase64Url(credential.rawId),
		publicKey: publicKey ? toBase64Url(publicKey) : null,
		algorithm: publicKey ? response.getPublicKeyAlgorithm() : null,
		userName,
		createdAt: Date.now(),
	};
	localStorage.setItem(STORAGE_KEY, JSON.stringify(passkey));
	return passkey;
};

export const signInWithPasskey = async (
	passkey: StoredPasskey,
): Promise<SignInResult> => {
	const challenge = randomBytes(32);
	const assertion = (await navigator.credentials.get({
		publicKey: {
			challenge,
			rpId: location.hostname,
			allowCredentials: [
				{ type: "public-key", id: fromBase64Url(passkey.credentialId) },
			],
			userVerification: "preferred",
			timeout: 60_000,
		},
	})) as PublicKeyCredential | null;

	if (!assertion) {
		throw new Error("The authenticator did not return an assertion.");
	}
	if (toBase64Url(assertion.rawId) !== passkey.credentialId) {
		throw new Error("The authenticator answered with a different credential.");
	}

	const response = assertion.response as AuthenticatorAssertionResponse;
	await assertClientData(response.clientDataJSON, challenge);
	await assertAuthenticatorData(response.authenticatorData);

	const signatureVerified = await verifySignature(passkey, response);
	if (passkey.publicKey && !signatureVerified) {
		throw new Error(
			"The assertion signature did not match the stored public key.",
		);
	}

	return { userName: passkey.userName, signatureVerified };
};

const assertClientData = async (
	clientDataJSON: ArrayBuffer,
	challenge: Uint8Array,
): Promise<void> => {
	const clientData = JSON.parse(new TextDecoder().decode(clientDataJSON)) as {
		type: string;
		challenge: string;
		origin: string;
	};
	if (clientData.type !== "webauthn.get") {
		throw new Error(`Unexpected ceremony type: ${clientData.type}`);
	}
	if (clientData.challenge !== toBase64Url(challenge.buffer as ArrayBuffer)) {
		throw new Error("The authenticator signed a different challenge.");
	}
	if (clientData.origin !== location.origin) {
		throw new Error(`The assertion was made for ${clientData.origin}.`);
	}
};

const assertAuthenticatorData = async (
	authenticatorData: ArrayBuffer,
): Promise<void> => {
	const data = new Uint8Array(authenticatorData);
	const expectedRpIdHash = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(location.hostname),
		),
	);
	const rpIdHashMatches = expectedRpIdHash.every(
		(byte, index) => byte === data[index],
	);
	if (!rpIdHashMatches) {
		throw new Error("The assertion was made for a different relying party.");
	}
	const userPresent = (data[32] & 0x01) !== 0;
	if (!userPresent) {
		throw new Error("The authenticator did not report user presence.");
	}
};

const verifySignature = async (
	passkey: StoredPasskey,
	response: AuthenticatorAssertionResponse,
): Promise<boolean> => {
	if (!passkey.publicKey || passkey.algorithm === null) {
		return false;
	}
	const algorithm =
		passkey.algorithm === ES256
			? ({ name: "ECDSA", namedCurve: "P-256" } as const)
			: ({ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const);
	const key = await crypto.subtle.importKey(
		"spki",
		fromBase64Url(passkey.publicKey),
		algorithm,
		false,
		["verify"],
	);

	const clientDataHash = new Uint8Array(
		await crypto.subtle.digest("SHA-256", response.clientDataJSON),
	);
	const authenticatorData = new Uint8Array(response.authenticatorData);
	const signedData = new Uint8Array(
		authenticatorData.length + clientDataHash.length,
	);
	signedData.set(authenticatorData);
	signedData.set(clientDataHash, authenticatorData.length);

	const signature =
		passkey.algorithm === ES256
			? derToRawSignature(new Uint8Array(response.signature))
			: new Uint8Array(response.signature);
	const verifyAlgorithm =
		passkey.algorithm === ES256
			? { name: "ECDSA", hash: "SHA-256" }
			: { name: "RSASSA-PKCS1-v1_5" };

	return crypto.subtle.verify(verifyAlgorithm, key, signature, signedData);
};

/** WebAuthn signs ES256 as an ASN.1 SEQUENCE of two INTEGERs; WebCrypto wants raw r||s. */
const derToRawSignature = (der: Uint8Array): Uint8Array => {
	const raw = new Uint8Array(64);
	let offset = 2;
	for (const half of [0, 32]) {
		offset += 1;
		const length = der[offset];
		offset += 1;
		const value = der.subarray(
			offset + Math.max(0, length - 32),
			offset + length,
		);
		raw.set(value, half + 32 - value.length);
		offset += length;
	}
	return raw;
};
