/**
 * Passkey sign-in and registration. The WebAuthn calls and the relying party
 * (in this browser or on the backend) live in src/lib/passkey; this
 * component only holds the UI state.
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
	logError,
	signalNoAcceptedCredentials,
	signalUnknownCredential,
} from "@/lib/passkey";
import { type FormEvent, useEffect, useRef, useState } from "react";
import "./PasskeyLogin.css";

/** `pending`: the browser prompt is open. `verifying`: the relying party checks the result. */
type Status =
	| "loading"
	| "idle"
	| "pending"
	| "verifying"
	| "success"
	| "error";

const isBusy = (status: Status): boolean =>
	status === "loading" || status === "pending" || status === "verifying";

export function PasskeyLogin() {
	const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
	const [user, setUserState] = useState<User | null>(null);
	const [status, setStatusState] = useState<Status>("loading");
	const [message, setMessage] = useState("");
	const [userName, setUserName] = useState("");
	const [displayName, setDisplayName] = useState("");

	/**
	 * A ceremony runs across several awaits and must act on the state as it
	 * is by then, not as it was in the render that started it. So the async
	 * code below reads these mirrors, which are written together with the
	 * state. The relying party is browser-only and created after hydration.
	 */
	const live = useRef({
		relyingParty: null as RelyingParty | null,
		capabilities: null as Capabilities | null,
		user: null as User | null,
		status: "loading" as Status,
		autofillPending: false,
	});

	const setUser = (next: User | null) => {
		live.current.user = next;
		setUserState(next);
	};

	const setStatus = (next: Status) => {
		live.current.status = next;
		setStatusState(next);
	};

	const succeed = (text: string) => {
		setStatus("success");
		setMessage(text);
	};

	/** An AbortError means our own code cancelled the request, so it stays silent. */
	const fail = (cause: unknown, ceremony: Ceremony) => {
		const text = describeError(cause, ceremony);
		setStatus(text === null ? "idle" : "error");
		setMessage(text ?? "");
	};

	const verifySignIn = async (credential: AuthenticationResponseJSON) => {
		const { relyingParty } = live.current;
		if (!relyingParty) {
			return;
		}
		setStatus("verifying");
		try {
			setUser(await relyingParty.verifyAuthentication(credential));
			succeed("Signed in with your passkey.");
		} catch (cause) {
			if (
				cause instanceof PasskeyError &&
				cause.code === "unknown_credential"
			) {
				void signalUnknownCredential(relyingParty.rpId, credential.id);
			}
			fail(cause, "authentication");
		}
	};

	/**
	 * Keeps a conditional request pending so the browser offers passkeys in the
	 * username autofill. Any modal ceremony aborts it; it restarts once that ends.
	 */
	const startAutofill = async () => {
		const state = live.current;
		if (
			!state.relyingParty ||
			!state.capabilities?.conditionalMediation ||
			state.user ||
			state.autofillPending
		) {
			return;
		}
		state.autofillPending = true;
		let credential: AuthenticationResponseJSON;
		try {
			const options = await state.relyingParty.authenticationOptions();
			// A modal ceremony may have started while the options were on their way.
			if (isBusy(state.status) || state.user) {
				state.autofillPending = false;
				return;
			}
			credential = await getPasskey(options, "conditional");
		} catch (cause) {
			// Nothing to show: either a modal ceremony replaced this request, or the
			// browser settled it before the user picked a passkey. The buttons still
			// work, and focusing the username field starts a new request.
			state.autofillPending = false;
			logError(cause, "authentication");
			return;
		}
		state.autofillPending = false;
		await verifySignIn(credential);
		void startAutofill();
	};

	const signIn = async () => {
		const { relyingParty } = live.current;
		if (!relyingParty) {
			return;
		}
		setStatus("pending");
		setMessage("");
		try {
			const options = await relyingParty.authenticationOptions();
			await verifySignIn(await getPasskey(options));
		} catch (cause) {
			fail(cause, "authentication");
		}
		void startAutofill();
	};

	const register = async (input: {
		userName: string;
		displayName?: string;
	}) => {
		const { relyingParty } = live.current;
		if (!relyingParty) {
			return;
		}
		const adding = live.current.user !== null;
		setStatus("pending");
		setMessage("");
		try {
			// Rejects a taken username before any authenticator prompt opens.
			const options = await relyingParty.registrationOptions(input);
			const credential = await createPasskey(options);
			setStatus("verifying");
			setUser(await relyingParty.verifyRegistration(credential));
			succeed(
				adding
					? "Another passkey was added to your account."
					: "Passkey created — you're signed in.",
			);
			setUserName("");
			setDisplayName("");
		} catch (cause) {
			fail(cause, "registration");
		}
		void startAutofill();
	};

	const handleCreate = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const name = userName.trim();
		if (!name) {
			fail(
				new PasskeyError("invalid_username", "Empty username."),
				"registration",
			);
			return;
		}
		void register({
			userName: name,
			displayName: displayName.trim() || undefined,
		});
	};

	const handleAddPasskey = () => {
		const account = live.current.user;
		if (account) {
			void register({ userName: account.name });
		}
	};

	const handleSignOut = async () => {
		const { relyingParty } = live.current;
		if (!relyingParty) {
			return;
		}
		try {
			await relyingParty.signOut();
			setUser(null);
			setStatus("idle");
			setMessage("");
		} catch (cause) {
			fail(cause, "session");
		}
		void startAutofill();
	};

	const handleDeleteAccount = async () => {
		const { relyingParty, user: account } = live.current;
		if (
			!relyingParty ||
			!account ||
			!window.confirm(`Delete ${account.name} and its passkeys from this site?`)
		) {
			return;
		}
		try {
			await relyingParty.deleteAccount();
			void signalNoAcceptedCredentials(relyingParty.rpId, account.id);
			setUser(null);
			succeed(
				"Account deleted. If your password manager still lists its passkey, remove it there.",
			);
		} catch (cause) {
			fail(cause, "session");
		}
		void startAutofill();
	};

	// Runs once after hydration: everything it touches exists only in the browser.
	// The functions it calls read `live`, so they need not be dependencies.
	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-only effect, see above
	useEffect(() => {
		// React may mount twice in development; the abandoned run stops at its next await.
		let active = true;
		void (async () => {
			const detected = await detectCapabilities();
			if (!active) {
				return;
			}
			live.current.capabilities = detected;
			setCapabilities(detected);
			if (!detected.webauthn) {
				setStatus("idle");
				return;
			}
			const relyingParty = createRelyingParty();
			live.current.relyingParty = relyingParty;
			try {
				const current = await relyingParty.currentUser();
				if (!active) {
					return;
				}
				setUser(current);
				setStatus("idle");
			} catch (cause) {
				if (!active) {
					return;
				}
				fail(cause, "session");
			}
			void startAutofill();
		})();
		return () => {
			active = false;
			abortPendingRequest();
		};
	}, []);

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
					<p className="message">
						Signed in as {user.displayName}
						{user.displayName === user.name ? "" : ` (${user.name})`}
					</p>
					<button type="button" onClick={handleAddPasskey} disabled={busy}>
						Add a passkey
					</button>
					<button type="button" onClick={handleSignOut} disabled={busy}>
						Sign out
					</button>
					<button type="button" onClick={handleDeleteAccount} disabled={busy}>
						Delete account
					</button>
				</>
			) : (
				<>
					<form onSubmit={handleCreate}>
						<label>
							Username
							<input
								name="username"
								autoComplete="username webauthn"
								autoCapitalize="none"
								spellCheck={false}
								required
								value={userName}
								onChange={(event) => setUserName(event.target.value)}
								onFocus={() => void startAutofill()}
							/>
						</label>
						<label>
							Display name (optional)
							<input
								name="display-name"
								autoComplete="name"
								value={displayName}
								onChange={(event) => setDisplayName(event.target.value)}
							/>
						</label>
						<button type="submit" disabled={busy}>
							Create a passkey
						</button>
						<button type="button" onClick={signIn} disabled={busy}>
							Sign in with a passkey
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
