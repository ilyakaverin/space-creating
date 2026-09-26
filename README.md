# Next.js learning

```
pnpm install
```

```
pnpm dev
```

Developer build will be served on localhost:3000

Tech stack: next.js 16 (app router, turbopack), react 19, typescript, biome

The page is prerendered at build time; `next start` serves it and the API routes from one Node server.

Installable as a PWA: `public/favicon/site.webmanifest` plus `public/service-worker.js`. The worker caches the page and the files it names when it installs, serves Next.js's content-hashed files from its cache, and keeps the last page as an offline fallback; `/api/` is never cached. It is only registered in production builds, so test it with `pnpm build && pnpm start` over https or localhost.

## Passkeys

`src/components/PasskeyLogin.tsx` registers and signs in with passkeys (WebAuthn): a username field with passkey autofill, "Create a passkey", "Sign in with a passkey", and, once signed in, "Add a passkey", "Sign out" and "Delete account". Passkeys only work in a secure context — https, or `localhost` in development (not the LAN address `pnpm dev` also prints).

The UI talks to a relying party (`src/lib/passkey/types.ts`) that issues options and verifies credentials. There are two, and they speak the same JSON contract:

- **In the browser (default).** `local-relying-party.ts` issues challenges in memory, keeps accounts and public keys in `localStorage`, keeps the signed-in user in `sessionStorage`, and verifies signatures with WebCrypto. Good for trying the ceremonies without a server, but not an authentication boundary: anyone can edit that storage.
- **On a backend.** Set `NEXT_PUBLIC_PASSKEY_API_URL` and `http-relying-party.ts` sends the same requests to that backend. Set `NEXT_PUBLIC_PASSKEY_RP_ID` too if the backend's RP ID is not this page's hostname; it is only used for Signal API calls. Next.js writes `NEXT_PUBLIC_` values into the code at build time, so set them before `pnpm build`.

### Built-in backend

This app ships its own backend in `src/lib/server/passkey/` (Next.js route handlers under `src/app/api/passkey`, `@simplewebauthn/server`, SQLite via `better-sqlite3`); [its README](src/lib/server/passkey/README.md) walks through the files. It starts only when `NEXT_PUBLIC_PASSKEY_API_URL=/api/passkey`.

```
cp .env.example .env     # sets NEXT_PUBLIC_PASSKEY_API_URL=/api/passkey
pnpm dev                 # reads .env; origin defaults to http://localhost:3000; passkeys go to data/passkeys.sqlite
```

For production: `pnpm build && pnpm start` (both read `.env`), with `PASSKEY_ORIGIN` set to the public https origin; a missing or invalid setting stops the server at startup with a list of the problems. Rate limits count per client IP, which a route handler can only read from a header: by default the rightmost `X-Forwarded-For` entry, which Next.js fills in from the connection when a request has none. So run it behind a reverse proxy that appends to `X-Forwarded-For` — without one, clients can send their own. With several proxies set `PASSKEY_XFF_DEPTH` to their number, or point `PASSKEY_CLIENT_IP_HEADER` at a header your proxy sets, such as `x-real-ip`. Back up the database with SQLite's online backup (`sqlite3 data/passkeys.sqlite ".backup backup.sqlite"`), not by copying the live file. `GET /api/health` answers `{ "ok": true, "passkeyBackend": "on" }` once the database is reachable.

### Backend contract

The full backend specification (validation, challenges, sessions, verification rules, data model, security, tests) is in [`docs/passkey-backend-requirements.md`](docs/passkey-backend-requirements.md).

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

- `pnpm dev` — dev server on port 3000 (Turbopack, hot reload)
- `pnpm build` — production build to `.next`
- `pnpm start` — serve the production build, port via `PORT` (default 3000)
- `pnpm check` — generate Next.js route types, then type check with `tsc`
- `pnpm test` — unit tests (Vitest)
- `pnpm test:e2e` — end-to-end passkey tests (Playwright with a virtual authenticator; builds the app and runs it in backend mode). Needs Chromium once: `pnpm exec playwright install chromium`
- `pnpm lint` — biome lint + format check
- `pnpm format` — biome format, writing changes

## History

V1: react, react router v6, redux, redux toolkit, parcel, typescript

V2: migrated to pnpm and vite, added rtk query, refactored all components and design

V3: migrated to svelte, evaporated old project

V4: migrated to sveltekit with server-side rendering

V5: migrated to next.js (app router) and react 19; passkey sign-in with a built-in backend
