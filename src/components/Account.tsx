/**
 * The home page's account corner: who is signed in, with "Sign out", or a
 * link to the login page.
 */
"use client";

import Link from "next/link";
import { StatusLine } from "./StatusLine";
import { IDLE, failure, isBusy, usePasskeySession } from "./usePasskeySession";
import "./passkey.css";

export function Account() {
	const { user, setUser, feedback, setFeedback, relyingParty } =
		usePasskeySession();
	const busy = isBusy(feedback.status);

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
			 * Nothing until the session is known: a "Log in" link would
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
			) : (
				<Link className="button" href="/login">
					Log in
				</Link>
			)}
			<StatusLine {...feedback} />
		</section>
	);
}
