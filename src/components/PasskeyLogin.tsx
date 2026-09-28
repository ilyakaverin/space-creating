/**
 * Passkey sign-up and sign-in. The WebAuthn calls and the backend client
 * live in src/lib/passkey; this component only holds the UI state.
 *
 * There is no form: creating a passkey creates an account whose name the
 * backend generates, and signing in lets the browser offer every passkey
 * this site has on the device.
 */
"use client";

import {
	type AuthenticationResponseJSON,
	type Capabilities,
	type Ceremony,
	PasskeyError,
	type RelyingParty,
	type User,
	abortPendingRequest,
	createPasskey,
	createRelyingParty,
	describeError,
	detectCapabilities,
	getPasskey,
	signalUnknownCredential,
} from "@/lib/passkey";
import { useEffect, useRef, useState } from "react";
import "./PasskeyLogin.css";

/** `pending`: the browser prompt is open. `verifying`: the backend checks the result. */
type Status =
	| "loading"
	| "idle"
	| "pending"
	| "verifying"
	| "success"
	| "error";

interface Feedback {
	status: Status;
	message: string;
}

const isBusy = (status: Status): boolean =>
	status === "loading" || status === "pending" || status === "verifying";

/** An AbortError means our own code cancelled the request, so it stays silent. */
const failure = (cause: unknown, ceremony: Ceremony): Feedback => {
	const text = describeError(cause, ceremony);
	return text === null
		? { status: "idle", message: "" }
		: { status: "error", message: text };
};

export function PasskeyLogin() {
	const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
	const [user, setUser] = useState<User | null>(null);
	const [feedback, setFeedback] = useState<Feedback>({
		status: "loading",
		message: "",
	});
	/** Talks to the backend; browser-only, so created after hydration. */
	const relyingParty = useRef<RelyingParty | null>(null);

	const createAccount = async () => {
		const backend = relyingParty.current;
		if (!backend) {
			return;
		}
		setFeedback({ status: "pending", message: "" });
		try {
			const credential = await createPasskey(
				await backend.registrationOptions(),
			);
			setFeedback({ status: "verifying", message: "" });
			setUser(await backend.verifyRegistration(credential));
			setFeedback({
				status: "success",
				message: "Passkey created — you're signed in.",
			});
		} catch (cause) {
			setFeedback(failure(cause, "registration"));
		}
	};

	const signIn = async () => {
		const backend = relyingParty.current;
		if (!backend) {
			return;
		}
		setFeedback({ status: "pending", message: "" });
		let credential: AuthenticationResponseJSON | null = null;
		try {
			credential = await getPasskey(await backend.authenticationOptions());
			setFeedback({ status: "verifying", message: "" });
			setUser(await backend.verifyAuthentication(credential));
			setFeedback({
				status: "success",
				message: "Signed in with your passkey.",
			});
		} catch (cause) {
			// The passkey belongs to no account here (any more): let the password
			// manager hide it, so it is not offered again.
			if (
				credential &&
				cause instanceof PasskeyError &&
				cause.code === "unknown_credential"
			) {
				void signalUnknownCredential(backend.rpId, credential.id);
			}
			setFeedback(failure(cause, "authentication"));
		}
	};

	const signOut = async () => {
		const backend = relyingParty.current;
		if (!backend) {
			return;
		}
		try {
			await backend.signOut();
			setUser(null);
			setFeedback({ status: "idle", message: "" });
		} catch (cause) {
			setFeedback(failure(cause, "session"));
		}
	};

	// Runs once after hydration: everything it touches exists only in the browser.
	useEffect(() => {
		// React may mount twice in development; the abandoned run stops at its next await.
		let active = true;
		void (async () => {
			const detected = await detectCapabilities();
			if (!active) {
				return;
			}
			setCapabilities(detected);
			if (!detected.webauthn) {
				setFeedback({ status: "idle", message: "" });
				return;
			}
			const backend = createRelyingParty();
			relyingParty.current = backend;
			try {
				const current = await backend.currentUser();
				if (active) {
					setUser(current);
					setFeedback({ status: "idle", message: "" });
				}
			} catch (cause) {
				if (active) {
					setFeedback(failure(cause, "session"));
				}
			}
		})();
		return () => {
			active = false;
			abortPendingRequest();
		};
	}, []);

	const { status, message } = feedback;
	const busy = isBusy(status);

	return (
		<section className="passkey" aria-busy={busy}>
			{capabilities && !capabilities.webauthn ? (
				<p className="message error">
					{capabilities.secureContext
						? "This browser doesn't support passkeys."
						: "Passkeys need a secure connection — open this page over https."}
				</p>
			) : user ? (
				<>
					<p className="message">Signed in as {user.name}</p>
					<button type="button" onClick={signOut} disabled={busy}>
						Sign out
					</button>
				</>
			) : (
				<>
					<button type="button" onClick={createAccount} disabled={busy}>
						Create a passkey
					</button>
					<button type="button" onClick={signIn} disabled={busy}>
						Sign in with a passkey
					</button>
					{capabilities?.webauthn && !capabilities.platformAuthenticator && (
						<p className="message">
							No built-in authenticator found — you can still use a phone or a
							security key.
						</p>
					)}
				</>
			)}

			<p className="message" aria-live="polite">
				{status === "pending" ? (
					"Waiting for your authenticator…"
				) : status === "verifying" ? (
					"Verifying…"
				) : status === "error" ? (
					<span className="error">{message}</span>
				) : (
					message
				)}
			</p>
		</section>
	);
}
