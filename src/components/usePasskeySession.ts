/**
 * What the home page and the login page share: the backend client, the
 * browser's WebAuthn support, the signed-in user and the status line. The
 * WebAuthn calls themselves live in src/lib/passkey.
 */
import {
	type Capabilities,
	type Ceremony,
	type RelyingParty,
	type User,
	abortPendingRequest,
	createRelyingParty,
	describeError,
	detectCapabilities,
} from "@/lib/passkey";
import { useEffect, useRef, useState } from "react";

/** `pending`: the browser prompt is open. `verifying`: the backend checks the result. */
export type Status = "loading" | "idle" | "pending" | "verifying" | "error";

export interface Feedback {
	status: Status;
	message: string;
}

export const IDLE: Feedback = { status: "idle", message: "" };

/** How long the page may stay empty while loading before it says "Loading…". */
const SLOW_AFTER_MS = 1_000;

export const isBusy = (status: Status): boolean =>
	status === "loading" || status === "pending" || status === "verifying";

/** An AbortError means our own code cancelled the request, so it stays silent. */
export const failure = (cause: unknown, ceremony: Ceremony): Feedback => {
	const text = describeError(cause, ceremony);
	return text === null ? IDLE : { status: "error", message: text };
};

export function usePasskeySession() {
	const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
	const [user, setUser] = useState<User | null>(null);
	const [feedback, setFeedback] = useState<Feedback>({
		status: "loading",
		message: "",
	});
	/** Talks to the backend; browser-only, so created after hydration. */
	const relyingParty = useRef<RelyingParty | null>(null);

	// Runs once after hydration: everything it touches exists only in the browser.
	useEffect(() => {
		// React may mount twice in development; the abandoned run stops at its next await.
		let active = true;
		// Fast answers show nothing in between; a slow one (a cold server, a
		// sleeping database) says so, instead of looking like a broken page.
		const slow = setTimeout(() => {
			setFeedback((current) =>
				current.status === "loading"
					? { status: "loading", message: "Loading…" }
					: current,
			);
		}, SLOW_AFTER_MS);
		void (async () => {
			const backend = createRelyingParty();
			relyingParty.current = backend;
			// Side by side: the session request is what the page waits for.
			const [detected, session] = await Promise.all([
				detectCapabilities(),
				backend.currentUser().then(
					(current) => ({ current }),
					(cause: unknown) => ({ cause }),
				),
			]);
			clearTimeout(slow);
			if (!active) {
				return;
			}
			setCapabilities(detected);
			// Without WebAuthn the page already explains that passkeys cannot
			// work here; a failed session request would add nothing.
			if ("cause" in session && detected.webauthn) {
				setFeedback(failure(session.cause, "session"));
			} else {
				setUser("current" in session ? session.current : null);
				setFeedback(IDLE);
			}
		})();
		return () => {
			active = false;
			clearTimeout(slow);
			abortPendingRequest();
		};
	}, []);

	return {
		capabilities,
		user,
		setUser,
		feedback,
		setFeedback,
		relyingParty,
	};
}
