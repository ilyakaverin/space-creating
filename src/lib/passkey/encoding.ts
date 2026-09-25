/** WebAuthn binary fields travel as base64url (RFC 4648 §5, unpadded), never plain base64. */

export const toBase64Url = (data: ArrayBuffer | ArrayBufferView): string => {
	const bytes = ArrayBuffer.isView(data)
		? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
		: new Uint8Array(data);
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
};

export const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
	const padded = value
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.padEnd(Math.ceil(value.length / 4) * 4, "=");
	const binary = atob(padded);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

export const randomBase64Url = (length: number): string =>
	toBase64Url(crypto.getRandomValues(new Uint8Array(length)));
