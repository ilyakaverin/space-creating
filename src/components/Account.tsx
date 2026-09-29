/**
 * The home page's account area. Signed out: "Sign in", which asks the
 * browser for a passkey right here, and a "Sign up" link to /register.
 * Signed in: who, with "Sign out".
 *
 * Sign-in needs no username: the browser offers the passkeys it holds for
 * this site, and the chosen one says whose account it is.
 */
"use client";

import {
	type AuthenticationResponseJSON,
	PasskeyError,
	getPasskey,
	signalUnknownCredential,
} from "@/lib/passkey";
import Link from "next/link";
import { StatusLine } from "./StatusLine";
import { IDLE, failure, isBusy, usePasskeySession } from "./usePasskeySession";
import "./passkey.css";

export function Account() {
	const { capabilities, user, setUser, feedback, setFeedback, relyingParty } =
		usePasskeySession();
	const busy = isBusy(feedback.status);

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
			setFeedback(IDLE);
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
			setFeedback(IDLE);
		} catch (cause) {
			setFeedback(failure(cause, "session"));
		}
	};

	return (
		<section className="passkey" aria-busy={busy}>
			{/*
			 * Nothing until the session is known: the sign-in buttons would
			 * otherwise flash for a visitor who is signed in. The page is
			 * prerendered, so the server's HTML has this empty state too.
			 */}
			{feedback.status === "loading" ? null : user ? (
				<>
					<p className="message">Signed in as {user.name}</p>
					<button type="button" onClick={signOut} disabled={busy}>
						Sign out
					</button>
				</>
			) : capabilities && !capabilities.webauthn ? (
				<p className="message error">
					{capabilities.secureContext
						? "This browser doesn't support passkeys."
						: "Passkeys need a secure connection — open this page over https."}
				</p>
			) : (
				<>
					<button
						type="button"
						className="primary"
						onClick={signIn}
						disabled={busy}
					>
						Sign in
					</button>
					<Link className="link" href="/register">
						Sign up
					</Link>
				</>
			)}
			<noscript>
				<p className="message error">
					Passkeys need JavaScript — turn it on to sign in.
				</p>
			</noscript>
			<StatusLine {...feedback} />
		</section>
	);
}
