import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { describe, expect, it } from "vitest";
import { ApiError } from "./errors";
import {
	decodeClientData,
	parseAuthenticationResponse,
	parseRegistrationResponse,
} from "./validation";

const codeOf = (run: () => unknown): string | undefined => {
	try {
		run();
	} catch (error) {
		return error instanceof ApiError ? error.code : "not an ApiError";
	}
	return undefined;
};

const registration = {
	id: "Y3JlZC1pZA",
	rawId: "Y3JlZC1pZA",
	type: "public-key",
	authenticatorAttachment: "platform",
	clientExtensionResults: {},
	response: {
		clientDataJSON: "e30",
		attestationObject: "o2Nm",
		authenticatorData: "ignored",
		publicKey: "ignored",
		publicKeyAlgorithm: -7,
		transports: ["internal", "hybrid", "carrier-pigeon", "internal"],
	},
};

describe("parseRegistrationResponse", () => {
	it("keeps only verified fields and known transports", () => {
		const parsed = parseRegistrationResponse(registration);
		expect(parsed.response).toEqual({
			clientDataJSON: "e30",
			attestationObject: "o2Nm",
			transports: ["internal", "hybrid"],
		});
		expect(parsed.authenticatorAttachment).toBe("platform");
	});

	it("rejects mismatched ids, plain base64 and a wrong type", () => {
		expect(
			codeOf(() => parseRegistrationResponse({ ...registration, rawId: "eA" })),
		).toBe("invalid_request");
		expect(
			codeOf(() =>
				parseRegistrationResponse({
					...registration,
					response: { ...registration.response, clientDataJSON: "e30=" },
				}),
			),
		).toBe("invalid_request");
		expect(
			codeOf(() => parseRegistrationResponse({ ...registration, type: "x" })),
		).toBe("invalid_request");
		expect(codeOf(() => parseRegistrationResponse(null))).toBe(
			"invalid_request",
		);
	});
});

describe("parseAuthenticationResponse", () => {
	it("allows a missing userHandle but not a malformed one", () => {
		const assertion = {
			id: "Y3JlZA",
			rawId: "Y3JlZA",
			type: "public-key",
			clientExtensionResults: {},
			response: {
				clientDataJSON: "e30",
				authenticatorData: "AAAA",
				signature: "c2ln",
			},
		};
		expect(
			parseAuthenticationResponse(assertion).response.userHandle,
		).toBeUndefined();
		expect(
			codeOf(() =>
				parseAuthenticationResponse({
					...assertion,
					response: { ...assertion.response, userHandle: "not base64url!" },
				}),
			),
		).toBe("invalid_request");
	});
});

describe("decodeClientData", () => {
	it("reads type, challenge and origin", () => {
		const encoded = isoBase64URL.fromUTF8String(
			JSON.stringify({
				type: "webauthn.get",
				challenge: "abc",
				origin: "https://example.com",
			}),
		);
		expect(decodeClientData(encoded)).toMatchObject({ challenge: "abc" });
	});

	it("rejects anything that is not client data", () => {
		expect(codeOf(() => decodeClientData("bm90IGpzb24"))).toBe(
			"invalid_request",
		);
		expect(
			codeOf(() => decodeClientData(isoBase64URL.fromUTF8String("{}"))),
		).toBe("invalid_request");
	});
});
