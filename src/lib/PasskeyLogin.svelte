<script lang="ts">
import {
	type StoredPasskey,
	createPasskey,
	forgetPasskey,
	isPasskeySupported,
	loadPasskey,
	signInWithPasskey,
} from "./passkey";

const supported = isPasskeySupported();

let passkey = $state<StoredPasskey | null>(supported ? loadPasskey() : null);
let signedInAs = $state<string | null>(null);
let busy = $state(false);
let error = $state("");
let notice = $state("");

const label = $derived(passkey ? "Sign in with a passkey" : "Create a passkey");

const describe = (cause: unknown): string => {
	if (cause instanceof DOMException) {
		if (cause.name === "NotAllowedError") {
			return "The passkey prompt was dismissed or timed out.";
		}
		if (cause.name === "InvalidStateError") {
			return "This device already holds a passkey for creating space.";
		}
		if (cause.name === "SecurityError") {
			return "Passkeys need a secure origin — serve the page over https or localhost.";
		}
	}
	return cause instanceof Error
		? cause.message
		: "The passkey ceremony failed.";
};

const run = async (ceremony: () => Promise<void>) => {
	busy = true;
	error = "";
	notice = "";
	try {
		await ceremony();
	} catch (cause) {
		error = describe(cause);
	} finally {
		busy = false;
	}
};

const handleClick = () =>
	run(async () => {
		const existing = passkey;
		if (!existing) {
			passkey = await createPasskey("space traveller");
			notice = "Passkey created — press the button again to sign in.";
			return;
		}
		const result = await signInWithPasskey(existing);
		signedInAs = result.userName;
		notice = result.signatureVerified
			? "Assertion signature verified against the stored public key."
			: "Signed in, but this authenticator exposed no public key to verify against.";
	});

const handleSignOut = () => {
	signedInAs = null;
	notice = "";
	error = "";
};

const handleForget = () => {
	forgetPasskey();
	passkey = null;
	signedInAs = null;
	notice =
		"Passkey forgotten on this site — it still lives in your authenticator.";
	error = "";
};
</script>

<section class="passkey">
  {#if !supported}
    <p class="message error">This browser does not support passkeys.</p>
  {:else if signedInAs}
    <p class="message">Signed in as {signedInAs}</p>
    <button type="button" onclick={handleSignOut}>Sign out</button>
  {:else}
    <button type="button" onclick={handleClick} disabled={busy} aria-busy={busy}>
      {busy ? "Waiting for your authenticator…" : label}
    </button>
  {/if}

  {#if passkey && !signedInAs}
    <button type="button" class="ghost" onclick={handleForget} disabled={busy}>Forget this passkey</button>
  {/if}

  <p class="message" aria-live="polite">
    {#if error}
      <span class="error">{error}</span>
    {:else if notice}
      {notice}
    {/if}
  </p>
</section>

<style>
.passkey {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  margin-block-start: 1.5rem;
  max-width: 40ch;
  text-align: center;
}

button {
  background-color: var(--dark-card);
  border: 1px solid var(--gray);
  border-radius: 0.375rem;
  color: var(--light);
  cursor: pointer;
  font: inherit;
  font-size: clamp(0.875rem, 0.8rem + 0.6vw, 1.125rem);
  padding: 0.75em 1.5em;
  transition: background-color 150ms ease-in-out, border-color 150ms ease-in-out;
}

button:hover:not(:disabled),
button:focus-visible {
  background-color: var(--black);
  border-color: var(--orange);
}

button:disabled {
  cursor: progress;
  opacity: 0.6;
}

.ghost {
  background: none;
  border-color: transparent;
  color: var(--gray);
  padding: 0.25em 0.75em;
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
