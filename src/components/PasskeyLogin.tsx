/**
 * Passkey sign-up and sign-in. The WebAuthn calls and the backend client
 * live in src/lib/passkey; this component only holds the UI state.
 *
 * There is no form: creating a passkey creates an account whose name the
 * backend generates, and signing in lets the browser offer every passkey
 * this site has on the device.
 *
 * One passkey per device: once this browser has created or used one, only
 * sign-in is offered. "Create a passkey" comes back after a failed sign-in,
 * for someone whose passkey is gone; the authenticator still refuses to
 * create a second one if it holds the first (InvalidStateError).
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
	const [devicePasskey, setDevicePasskey] = useState(false);
	const [signInFailed, setSignInFailed] = useState(false);
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
			setDevicePasskey(true);
			setFeedback({
				status: "success",
				message: "Passkey created — you're signed in.",
			});
		} catch (cause) {
			// Refused because the device already has a passkey here: back to
			// offering sign-in only.
			if (cause instanceof DOMException && cause.name === "InvalidStateError") {
				setDevicePasskey(true);
				setSignInFailed(false);
			}
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
			setDevicePasskey(true);
			setSignInFailed(false);
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
			const next = failure(cause, "authentication");
			// Maybe there is no passkey here after all: offer to create one.
			if (next.status === "error") {
				setSignInFailed(true);
			}
			setFeedback(next);
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
			const backend = createRelyingParty();
			relyingParty.current = backend;
			// Side by side: the session request is what the page waits for.
			const [detected, session] = await Promise.all([
				detectCapabilities(),
				backend.session().then(
					(current) => ({ current }),
					(cause: unknown) => ({ cause }),
				),
			]);
			if (!active) {
				return;
			}
			setCapabilities(detected);
			// Without WebAuthn the page already explains that passkeys cannot
			// work here; a failed session request would add nothing.
			if ("cause" in session && detected.webauthn) {
				setFeedback(failure(session.cause, "session"));
			} else {
				if ("current" in session) {
					setUser(session.current.user);
					setDevicePasskey(session.current.devicePasskey);
				}
				setFeedback({ status: "idle", message: "" });
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
			{/*
			 * Nothing until the session is known: the sign-in buttons would
			 * otherwise flash for a visitor who is signed in. The page is
			 * prerendered, so the server's HTML has this empty state too.
			 */}
			{status === "loading" ? null : capabilities && !capabilities.webauthn ? (
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
			) : devicePasskey ? (
				<>
					<button type="button" onClick={signIn} disabled={busy}>
						Sign in with a passkey
					</button>
					{/* Below the sign-in button, so it does not move when this appears. */}
					{signInFailed && (
						<button type="button" onClick={createAccount} disabled={busy}>
							Create a passkey
						</button>
					)}
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
