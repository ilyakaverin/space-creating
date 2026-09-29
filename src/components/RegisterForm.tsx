/**
 * The register page's form: a username and "Sign up", which creates the
 * account with a passkey and then goes to the home page.
 *
 * A taken username is refused before any prompt opens — one username, one
 * account, one passkey, so a device can never hold two passkeys for the
 * same account.
 */
"use client";

import { PasskeyError, createPasskey } from "@/lib/passkey";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { StatusLine } from "./StatusLine";
import { failure, isBusy, usePasskeySession } from "./usePasskeySession";
import "./passkey.css";

export function RegisterForm() {
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

	const signUp = async (event: FormEvent<HTMLFormElement>) => {
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
					<form onSubmit={signUp}>
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
						<button type="submit" className="primary" disabled={busy}>
							Sign up
						</button>
					</form>
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
