# Passkey backend

The server half of passkey sign-in, specified in [`docs/passkey-backend-requirements.md`](../../../../docs/passkey-backend-requirements.md) (the `BR-*` IDs in the comments point there). The entry points import `server-only`, so Next.js fails the build if browser code ever imports them; the frontend (`src/lib/passkey/`) only talks to the backend over HTTP.

Data lives in Postgres (Neon on Vercel): accounts, passkeys, sessions, challenges and rate-limit counters. Nothing is kept in memory between requests, so any number of server instances can run at once.

## Files

Plain TypeScript, no Next.js imports — each takes its dependencies as arguments, so the unit tests can pass an in-memory database (PGlite) and a fake clock:

| File | Responsibility |
|---|---|
| `config.ts` | Reads and validates the environment (database URL, origins — from Vercel's variables if unset — RP ID, session lifetime) |
| `database.ts` | The `Db` interface, the Postgres connection pool, the schema migrations |
| `test-database.ts` | For unit tests: the same schema on PGlite, Postgres in WebAssembly |
| `errors.ts` | `ApiError`: an error code plus its HTTP status, recognised across bundled copies of the module |
| `validation.ts` | Checks every untrusted input: usernames, credential JSON, client data |
| `challenges.ts` | Issues challenges and redeems each exactly once, for the browser it was issued to |
| `sessions.ts` | Session tokens: create, validate (with sliding expiry), revoke |
| `accounts.ts` | Users and their stored passkeys |
| `rate-limit.ts` | Per-client request limits, counted in the database |
| `log.ts` | One-line JSON security log |
| `ceremonies.ts` | The WebAuthn logic: options, verification, sign-in, sign-out |
| `backend.ts` | Wires the above into one `PasskeyBackend` object, with `transaction()` for all-or-nothing writes |

Next.js glue:

| File | Responsibility |
|---|---|
| `runtime.ts` | Creates the backend from `process.env` once per process (shared through `globalThis`); the database connects and migrates on its first query. Schedules the cleanup of expired rows with `after()` |
| `cookies.ts` | Names and attributes of the session and flow cookies, on the store from `cookies()` |
| `http.ts` | `passkeyEndpoint` wrapper (Origin check, session cookie, client address, errors → JSON, no-cache headers), `readJson` |

Outside this folder: `src/instrumentation.ts` (starts the backend when the server starts), the thin route handlers in `src/app/api/passkey/`, and `src/app/api/health/`.

## What happens on a sign-in

1. **Page load** — the frontend shows no buttons yet and calls `GET /session`. The endpoint wrapper finds no session cookie and the route answers `{ "user": null }` without touching the database; the buttons appear.
2. **Options** — the frontend calls `POST /authentication/options`. The route sets a *flow cookie* (a random ID for this browser) and `startAuthentication` stores a fresh challenge tied to that ID.
3. **Authenticator** — the browser asks the user to pick a passkey; the authenticator signs the challenge with the passkey's private key, which never leaves the device.
4. **Verify** — `POST /authentication/verify` with the signed assertion. `finishAuthentication` then:
   - reads the challenge from `clientDataJSON` and deletes it from the database, so it can never be used again;
   - finds the passkey by its credential ID, or answers `unknown_credential`;
   - checks that the user handle names the passkey's owner;
   - lets `@simplewebauthn/server` verify origin, RP ID, user presence and the signature against the stored public key;
   - in one transaction, raises the passkey's signature counter — refusing if it did not grow — and creates a session.
5. **Cookie** — the route sets the httpOnly session cookie and answers `{ "user": … }`. From now on the endpoint wrapper resolves that cookie on every API request.

Registration is the same shape: `startRegistration` checks the username is free and stores the *pending* account — a random user handle and the name — with the challenge; `finishRegistration` verifies the new credential and only then creates the account, the passkey and the session, in one transaction.

## Running and testing

See the README's "Passkeys" section for setup. Tests:

- `pnpm test` — unit tests (`*.test.ts` next to the code), on PGlite.
- `pnpm test:e2e` — Playwright builds the app, starts it with `next start` on the Postgres database in `E2E_DATABASE_URL`, and signs in with Chromium's virtual authenticator (`tests/e2e/`).
