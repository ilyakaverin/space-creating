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

The home page shows who is signed in, with "Sign out", or a "Log in" link to `/login`. There, the username field comes first, then "Sign in" and, below it, "Sign up". "Sign in" with a username offers only that account's passkeys; with the field empty, the browser offers every passkey this device has for the site. "Sign up" makes an account under the username typed. A username has one account and an account one passkey, so a device never gets two passkeys for the same account; a taken username is refused before any prompt. Passkeys only work in a secure context — https, or `localhost` in development (not the LAN address `pnpm dev` also prints).

The UI talks to the backend through `src/lib/passkey/http-relying-party.ts`; nothing is stored in the browser. The backend lives in `src/lib/server/passkey/` (route handlers under `src/app/api/passkey`, `@simplewebauthn/server`) and keeps accounts, passkeys, sessions, challenges and rate limits in Postgres — Neon, created through Vercel. [Its README](src/lib/server/passkey/README.md) walks through the files.

### On Vercel

With the Neon integration installed on the project, nothing needs configuring: it sets `DATABASE_URL`, and the site's address comes from Vercel's own variables (the production domain in production, the branch URL in a preview — passkeys on a preview work on that URL only). The tables are created by the first request that needs the database. `GET /api/health` answers `{ "ok": true }` once the database is reachable.

### Locally

```
pnpm dlx vercel link                 # once: connect this folder to the Vercel project
pnpm dlx vercel env pull .env.local  # fetches DATABASE_URL (and Vercel's own variables)
pnpm dev                             # origin defaults to http://localhost:3000
```

That is the database the integration connected to Vercel's Development environment — unless you chose otherwise, the same one production uses, so accounts created locally land in the production tables. They cannot sign in there (passkeys are bound to the domain, and localhost is another one), but to keep them apart, create a branch of the database in Neon and put its connection string in `.env.local` as `DATABASE_URL`. Any other Postgres works too; `.env.example` lists every setting.

To self-host: `pnpm build && pnpm start`, with `PASSKEY_ORIGIN` set to the public https origin; invalid settings stop the server at startup with a list of the problems. Rate limits count per client IP, which a route handler can only read from a header: by default the rightmost `X-Forwarded-For` entry, which Vercel sets to the client's address. When self-hosting, run behind a reverse proxy that appends to `X-Forwarded-For` — without one, clients can send their own. With several proxies set `PASSKEY_XFF_DEPTH` to their number, or point `PASSKEY_CLIENT_IP_HEADER` at a header your proxy sets, such as `x-real-ip`.

### Backend contract

The full backend specification (validation, challenges, sessions, verification rules, data model, security, tests) is in [`docs/passkey-backend-requirements.md`](docs/passkey-backend-requirements.md).

Binary fields are base64url strings throughout. Options use the WebAuthn Level 3 JSON shapes (`PublicKeyCredentialCreationOptionsJSON` / `PublicKeyCredentialRequestOptionsJSON`), and credentials arrive as `PublicKeyCredential.toJSON()` output, with `response.transports` on registrations. Paths are under `/api/passkey`.

| Request | Body | Success |
| --- | --- | --- |
| `POST /registration/options` | `{ userName }` | creation options for a new account; `409 username_taken` if the name exists |
| `POST /registration/verify` | registration credential | `{ user }`, account created, session started |
| `POST /authentication/options` | `{ userName? }` | request options for that account's passkeys, or any discoverable passkey without a name; `404 unknown_user` if the name does not exist |
| `POST /authentication/verify` | assertion | `{ user }`, session started |
| `GET /session` | — | `{ user }` or `{ user: null }` |
| `DELETE /session` | — | 204, signed out |

`user` is `{ id, name }`, where `id` is the base64url user handle and `name` the username. Failures answer with a non-2xx status and `{ "code": "...", "message": "..." }`; the UI maps `invalid_username`, `username_taken`, `unknown_user`, `challenge_expired`, `unknown_credential`, `verification_failed`, `unsupported_authenticator` and `rate_limited` to its own text and shows a generic message for anything else. `message` is for developers and is only logged in development.

The backend owns everything security-relevant: challenges are random, single-use, tied to the browser that asked for them and expire with the ceremony timeout; the account a registration would create exists only with its challenge until the passkey is verified; `unknown_credential` is reserved for passkeys it does not know, because the UI then asks the password manager to hide that passkey. The UI fetches options right after the click and only then opens the prompt, so keep the `/options` endpoints fast: Safari rejects the prompt with `NotAllowedError` once user activation has expired. The session lives in an httpOnly, `SameSite` cookie. POST bodies are `application/json` and sign-out uses DELETE, so a cross-site form cannot forge them; the backend also checks `Origin`.

## Scripts

- `pnpm dev` — dev server on port 3000 (Turbopack, hot reload)
- `pnpm build` — production build to `.next`
- `pnpm start` — serve the production build, port via `PORT` (default 3000)
- `pnpm check` — generate Next.js route types, then type check with `tsc`
- `pnpm test` — unit tests (Vitest; the database tests run Postgres in memory with PGlite)
- `pnpm test:e2e` — end-to-end passkey tests (Playwright with a virtual authenticator; builds and starts the app). Needs a throwaway Postgres database, never the real one: `E2E_DATABASE_URL=postgresql://postgres:postgres@localhost/passkeys_e2e pnpm test:e2e`. Needs Chromium once: `pnpm exec playwright install chromium`
- `pnpm lint` — biome lint + format check
- `pnpm format` — biome format, writing changes

## History

V1: react, react router v6, redux, redux toolkit, parcel, typescript

V2: migrated to pnpm and vite, added rtk query, refactored all components and design

V3: migrated to svelte, evaporated old project

V4: migrated to sveltekit with server-side rendering

V5: migrated to next.js (app router) and react 19; passkey sign-in with a built-in backend

V6: usernameless passkeys, accounts stored in Neon Postgres on Vercel
