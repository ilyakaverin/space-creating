<script lang="ts">
import { onMount } from "svelte";
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
} from "./passkey";

/** `pending`: the browser prompt is open. `verifying`: the relying party checks the result. */
type Status =
	| "loading"
	| "idle"
	| "pending"
	| "verifying"
	| "success"
	| "error";

/** Everything here is browser-only, so it is resolved after hydration. */
let relyingParty: RelyingParty | null = null;
let autofillPending = false;
let capabilities = $state<Capabilities | null>(null);
let user = $state<User | null>(null);
let status = $state<Status>("loading");
let message = $state("");
let userName = $state("");
let displayName = $state("");

const busy = $derived(
	status === "loading" || status === "pending" || status === "verifying",
);

const succeed = (text: string) => {
	status = "success";
	message = text;
};

/** An AbortError means our own code cancelled the request, so it stays silent. */
const fail = (cause: unknown, ceremony: Ceremony) => {
	const text = describeError(cause, ceremony);
	status = text === null ? "idle" : "error";
	message = text ?? "";
};

const verifySignIn = async (credential: AuthenticationResponseJSON) => {
	if (!relyingParty) {
		return;
	}
	status = "verifying";
	try {
		user = await relyingParty.verifyAuthentication(credential);
		succeed("Signed in with your passkey.");
	} catch (cause) {
		if (cause instanceof PasskeyError && cause.code === "unknown_credential") {
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
	if (
		!relyingParty ||
		!capabilities?.conditionalMediation ||
		user ||
		autofillPending
	) {
		return;
	}
	autofillPending = true;
	let credential: AuthenticationResponseJSON;
	try {
		const options = await relyingParty.authenticationOptions();
		// A modal ceremony may have started while the options were on their way.
		if (busy || user) {
			autofillPending = false;
			return;
		}
		credential = await getPasskey(options, "conditional");
	} catch (cause) {
		// Nothing to show: either a modal ceremony replaced this request, or the
		// browser settled it before the user picked a passkey. The buttons still
		// work, and focusing the username field starts a new request.
		autofillPending = false;
		logError(cause, "authentication");
		return;
	}
	autofillPending = false;
	await verifySignIn(credential);
	void startAutofill();
};

const signIn = async () => {
	if (!relyingParty) {
		return;
	}
	status = "pending";
	message = "";
	try {
		const options = await relyingParty.authenticationOptions();
		await verifySignIn(await getPasskey(options));
	} catch (cause) {
		fail(cause, "authentication");
	}
	void startAutofill();
};

const register = async (input: { userName: string; displayName?: string }) => {
	if (!relyingParty) {
		return;
	}
	const adding = user !== null;
	status = "pending";
	message = "";
	try {
		// Rejects a taken username before any authenticator prompt opens.
		const options = await relyingParty.registrationOptions(input);
		const credential = await createPasskey(options);
		status = "verifying";
		user = await relyingParty.verifyRegistration(credential);
		succeed(
			adding
				? "Another passkey was added to your account."
				: "Passkey created — you're signed in.",
		);
		userName = "";
		displayName = "";
	} catch (cause) {
		fail(cause, "registration");
	}
	void startAutofill();
};

const handleCreate = (event: SubmitEvent) => {
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
	if (user) {
		void register({ userName: user.name });
	}
};

const handleSignOut = async () => {
	if (!relyingParty) {
		return;
	}
	try {
		await relyingParty.signOut();
		user = null;
		status = "idle";
		message = "";
	} catch (cause) {
		fail(cause, "session");
	}
	void startAutofill();
};

const handleDeleteAccount = async () => {
	const account = user;
	if (
		!relyingParty ||
		!account ||
		!confirm(`Delete ${account.name} and its passkeys from this site?`)
	) {
		return;
	}
	try {
		await relyingParty.deleteAccount();
		void signalNoAcceptedCredentials(relyingParty.rpId, account.id);
		user = null;
		succeed(
			"Account deleted. If your password manager still lists its passkey, remove it there.",
		);
	} catch (cause) {
		fail(cause, "session");
	}
	void startAutofill();
};

onMount(() => {
	void (async () => {
		capabilities = await detectCapabilities();
		if (!capabilities.webauthn) {
			status = "idle";
			return;
		}
		relyingParty = createRelyingParty();
		try {
			user = await relyingParty.currentUser();
			status = "idle";
		} catch (cause) {
			fail(cause, "session");
		}
		void startAutofill();
	})();
	return abortPendingRequest;
});
</script>

<section class="passkey" aria-busy={busy}>
  {#if capabilities && !capabilities.webauthn}
    <p class="message error">
      {capabilities.secureContext
        ? "This browser doesn't support passkeys."
        : "Passkeys need a secure connection — open this page over https."}
    </p>
  {:else if user}
    <p class="message">
      Signed in as {user.displayName}{user.displayName === user.name ? "" : ` (${user.name})`}
    </p>
    <button type="button" onclick={handleAddPasskey} disabled={busy}>Add a passkey</button>
    <button type="button" onclick={handleSignOut} disabled={busy}>Sign out</button>
    <button type="button" onclick={handleDeleteAccount} disabled={busy}>Delete account</button>
  {:else}
    <form onsubmit={handleCreate}>
      <label>
        Username
        <input
          name="username"
          autocomplete="username webauthn"
          autocapitalize="none"
          spellcheck="false"
          required
          bind:value={userName}
          onfocus={startAutofill}
        />
      </label>
      <label>
        Display name (optional)
        <input name="display-name" autocomplete="name" bind:value={displayName} />
      </label>
      <button type="submit" disabled={busy}>Create a passkey</button>
      <button type="button" onclick={signIn} disabled={busy}>Sign in with a passkey</button>
    </form>
    {#if capabilities?.webauthn && !capabilities.platformAuthenticator}
      <p class="message">
        No built-in authenticator found — you can still use a phone or a security key.
      </p>
    {/if}
  {/if}

  <p class="message" aria-live="polite">
    {#if status === "pending"}
      Waiting for your authenticator…
    {:else if status === "verifying"}
      Verifying…
    {:else if status === "error"}
      <span class="error">{message}</span>
    {:else}
      {message}
    {/if}
  </p>
</section>

<style>
.passkey,
form {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
}

.passkey {
  margin-block-start: 1.5rem;
  max-width: 40ch;
  text-align: center;
}

label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  color: var(--gray);
  font-size: 0.875rem;
}

.message {
  color: var(--gray);
  font-size: 0.875rem;
  line-height: 1.4;
  margin: 0;
  min-height: 1.4em;
  text-wrap: balance;
}

.error {
  color: var(--orange);
}
</style>
