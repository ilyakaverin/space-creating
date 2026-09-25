# Svelte learning

```
pnpm install
```

```
pnpm dev
```

Developer build will be served on localhost:3000

Tech stack: sveltekit, svelte 5, vite, typescript, biome

Pages are server-rendered; `@sveltejs/adapter-node` builds a standalone node server.

Installable as a PWA: `static/favicon/site.webmanifest` plus `src/service-worker.ts`, which precaches the build output and static files and keeps the last server render as an offline fallback. SvelteKit only registers the service worker in production builds, so test it with `pnpm build && pnpm start` over https or localhost.

## Passkeys

`src/lib/PasskeyLogin.svelte` registers and signs in with passkeys (WebAuthn): a username field with passkey autofill, "Create a passkey", "Sign in with a passkey", and, once signed in, "Add a passkey", "Sign out" and "Delete account". Passkeys only work in a secure context — https, or `localhost` in development (not the LAN address `pnpm dev` also prints).

The UI talks to a relying party (`src/lib/passkey/types.ts`) that issues options and verifies credentials. There are two, and they speak the same JSON contract:

- **In the browser (default).** `local-relying-party.ts` issues challenges in memory, keeps accounts and public keys in `localStorage`, keeps the signed-in user in `sessionStorage`, and verifies signatures with WebCrypto. Good for trying the ceremonies without a server, but not an authentication boundary: anyone can edit that storage.
- **On a backend.** Set `PUBLIC_PASSKEY_API_URL` (read at runtime, e.g. `PUBLIC_PASSKEY_API_URL=/api/passkey pnpm start`) and `http-relying-party.ts` sends the same requests to that backend. Set `PUBLIC_PASSKEY_RP_ID` too if the backend's RP ID is not this page's hostname; it is only used for Signal API calls.

### Backend contract

Binary fields are base64url strings throughout. Options use the WebAuthn Level 3 JSON shapes (`PublicKeyCredentialCreationOptionsJSON` / `PublicKeyCredentialRequestOptionsJSON`), and credentials arrive as `PublicKeyCredential.toJSON()` output, with `response.transports` on registrations.

| Request | Body | Success |
| --- | --- | --- |
| `POST /registration/options` | `{ userName, displayName? }` | creation options; `excludeCredentials` lists the user's passkeys |
| `POST /registration/verify` | registration credential | `{ user }`, session started |
| `POST /authentication/options` | `{}` | request options with empty `allowCredentials` (discoverable passkeys, autofill) |
| `POST /authentication/verify` | assertion | `{ user }`, session started |
| `GET /session` | — | `{ user }` or `{ user: null }` |
| `DELETE /session` | — | 204, signed out |
| `DELETE /account` | — | 204, the signed-in user and their passkeys are deleted |

`user` is `{ id, name, displayName }`, where `id` is the base64url user handle. Failures answer with a non-2xx status and `{ "code": "...", "message": "..." }`; the UI maps `invalid_username`, `username_taken`, `not_signed_in`, `challenge_expired`, `unknown_credential`, `verification_failed`, `unsupported_authenticator` and shows a generic message for anything else. `message` is for developers and is only logged in development.

The backend owns everything security-relevant: challenges are random, single-use and expire with the ceremony timeout; `/registration/options` answers `username_taken` for an existing name unless that user is signed in (then it adds a passkey); `unknown_credential` is reserved for passkeys it does not know, because the UI then asks the password manager to hide that passkey. The UI fetches options right after the click and only then opens the prompt, so keep the `/options` endpoints fast: Safari rejects the prompt with `NotAllowedError` once user activation has expired. The session lives in an httpOnly, `SameSite` cookie. Requests are sent with `credentials: "include"`, POST bodies are `application/json` and removals use DELETE, so a cross-site form cannot forge them; the backend should still reject other content types and check `Origin`.

## Scripts

- `pnpm dev` — dev server on port 3000
- `pnpm build` — production build to `build` (node server) and `.svelte-kit`
- `pnpm start` — run the built node server (`node build`), port via `PORT`
- `pnpm preview` — serve the production build through vite
- `pnpm check` — type/a11y check via `svelte-check`
- `pnpm lint` — biome lint + format check
- `pnpm format` — biome format, writing changes

## History

V1: react, react router v6, redux, redux toolkit, parcel, typescript

V2: migrated to pnpm and vite, added rtk query, refactored all components and design

V3: migrated to svelte, evaporated old project

V4: migrated to sveltekit with server-side rendering
