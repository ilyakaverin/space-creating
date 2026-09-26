# Passkey backend

The server half of passkey sign-in, specified in [`docs/passkey-backend-requirements.md`](../../../../docs/passkey-backend-requirements.md) (the `BR-*` IDs in the comments point there). It lives under `src/lib/server/`, so SvelteKit refuses to bundle any of it into browser code; the frontend (`src/lib/passkey/`) only talks to it over HTTP.

It is off unless `PUBLIC_PASSKEY_API_URL=/api/passkey`. Without that, the frontend keeps passkeys in the browser and none of this runs.

## Files

Plain TypeScript, no SvelteKit imports — each takes its dependencies as arguments, so the unit tests can pass an in-memory database and a fake clock:

| File | Responsibility |
|---|---|
| `config.ts` | Reads and validates the environment (origins, RP ID, database path, session lifetime) |
| `database.ts` | Opens SQLite, applies the schema migrations |
| `errors.ts` | `ApiError`: an error code plus its HTTP status |
| `validation.ts` | Checks every untrusted input: usernames, credential JSON, client data |
| `challenges.ts` | Issues challenges and redeems each exactly once, for the browser it was issued to |
| `sessions.ts` | Session tokens: create, validate (with sliding expiry), revoke |
| `accounts.ts` | Users and their stored passkeys |
| `rate-limit.ts` | Per-client request limits |
| `log.ts` | One-line JSON security log |
| `ceremonies.ts` | The WebAuthn logic: options, verification, sign-in, sign-out, account deletion |
| `backend.ts` | Wires the above into one `PasskeyBackend` object |

SvelteKit glue:

| File | Responsibility |
|---|---|
| `runtime.ts` | Starts the backend from `$env` once; resolves the session cookie for each request |
| `cookies.ts` | Names and attributes of the session and flow cookies |
| `http.ts` | `passkeyEndpoint` wrapper (Origin check, errors → JSON, no-cache headers), `readJson` |

Outside this folder: `src/hooks.server.ts` (starts the backend, resolves the session), the thin route files in `src/routes/api/passkey/`, and `src/routes/api/health/`.

## What happens on a sign-in

1. **Page load** — `hooks.server.ts` finds no session cookie, so `locals.user` is null. The frontend calls `GET /session` → `{ "user": null }`.
2. **Options** — the frontend calls `POST /authentication/options`. The route sets a *flow cookie* (a random ID for this browser) and `startAuthentication` stores a fresh challenge tied to that ID.
3. **Authenticator** — the browser asks the user to pick a passkey; the authenticator signs the challenge with the passkey's private key, which never leaves the device.
4. **Verify** — `POST /authentication/verify` with the signed assertion. `finishAuthentication` then:
   - reads the challenge from `clientDataJSON` and deletes it from the database, so it can never be used again;
   - finds the passkey by its credential ID, or answers `unknown_credential`;
   - checks that the user handle names the passkey's owner, and that the signature counter grew;
   - lets `@simplewebauthn/server` verify origin, RP ID, user presence and the signature against the stored public key;
   - in one transaction, updates the passkey's counter and creates a session.
5. **Cookie** — the route sets the httpOnly session cookie and answers `{ "user": … }`. From now on `hooks.server.ts` resolves that cookie on every request.

Registration is the same shape: `startRegistration` checks the username and remembers the *pending* account with the challenge; `finishRegistration` verifies the new credential and only then creates the account, the passkey and the session together.

## Running and testing

See the README's "Passkeys" section for setup. Tests:

- `pnpm test` — unit tests (`*.test.ts` next to the code).
- `pnpm test:e2e` — Playwright builds the app, starts it in backend mode with a temporary database, and signs in with Chromium's virtual authenticator (`tests/e2e/`).
