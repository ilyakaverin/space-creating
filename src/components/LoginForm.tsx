/**
 * The login page: create an account with a passkey under a username, or
 * sign in with a passkey this device already has. Either way, the browser
 * then goes to the home page.
 *
 * Sign-in needs no username: the browser offers the passkeys it holds for
 * this site. Registration does, and a taken username is refused before any
 * prompt opens — one username, one account, one passkey, so a device can
 * never hold two passkeys for the same account.
 */
"use client";

import {
	type AuthenticationResponseJSON,
	PasskeyError,
	createPasskey,
	getPasskey,
	signalUnknownCredential,
} from "@/lib/passkey";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { StatusLine } from "./StatusLine";
import { failure, isBusy, usePasskeySession } from "./usePasskeySession";
import "./passkey.css";

export function LoginForm() {
	const router = useRouter();
	const { capabilities, user, setUser, feedback, setFeedback, relyingParty } =
		usePasskeySession();
	const [userName, setUserName] = useState("");

	// Signed in — just now, or before the page was opened: nothing to do here.
	useEffect(() => {
		if (user) {
			router.replace("/");
		}
	}, [user, router]);

	const createAccount = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const backend = relyingParty.current;
		if (!backend) {
			return;
		}
		const name = userName.trim();
		if (!name) {
			setFeedback(
				failure(
					new PasskeyError("invalid_username", "Empty username."),
					"registration",
				),
			);
			return;
		}
		setFeedback({ status: "pending", message: "" });
		try {
			// Rejects a taken username before any authenticator prompt opens.
			const credential = await createPasskey(
				await backend.registrationOptions({ userName: name }),
			);
			setFeedback({ status: "verifying", message: "" });
			setUser(await backend.verifyRegistration(credential));
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

	// Signed in, the page is on its way home: it stays busy until it is gone.
	const busy = isBusy(feedback.status) || user !== null;

	return (
		<section className="passkey" aria-busy={busy}>
			{feedback.status === "loading" || user ? null : capabilities &&
				!capabilities.webauthn ? (
				<p className="message error">
					{capabilities.secureContext
						? "This browser doesn't support passkeys."
						: "Passkeys need a secure connection — open this page over https."}
				</p>
			) : (
				<>
					<form onSubmit={createAccount}>
						<label>
							Username
							<input
								name="username"
								autoComplete="username"
								autoCapitalize="none"
								spellCheck={false}
								maxLength={64}
								required
								value={userName}
								onChange={(event) => setUserName(event.target.value)}
							/>
						</label>
						<button type="submit" disabled={busy}>
							Create a passkey
						</button>
					</form>
					<p className="message">Already have one?</p>
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
			<StatusLine {...feedback} />
		</section>
	);
}
