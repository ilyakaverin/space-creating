# Passkey Login — Backend Requirements

Pet project goal: passkey sign-up and sign-in without usernames, with challenges, passkeys and sessions on a server and in a Postgres database (Neon, deployed on Vercel).
Scope: backend only, technical requirements, no implementation code.
Related: `passkey-frontend-requirements.md` (the `FR-*` IDs referenced below), the README section "Passkeys → Backend contract", and the client that calls this API, `src/lib/passkey/http-relying-party.ts`.

The words **MUST**, **SHOULD** and **MAY** are used as in RFC 2119.

---

## 1. Context

- The frontend (`src/lib/passkey/http-relying-party.ts`) implements the client side of the contract and always talks to this backend; nothing is stored in the browser. §12 lists optional follow-ups.
- The backend owns everything security-relevant: challenges, attestation and assertion verification, credential storage, accounts and sessions. The frontend only forwards opaque WebAuthn data.
- Accounts have no username or display name. "Create a passkey" makes a new account whose name the backend generates; "Sign in with a passkey" lets the browser offer every passkey the device holds for this site. A signed-in user can only sign out: there is no "add a passkey" and no account deletion. Each device gets one passkey (BR-REGO-9).

```
Browser ── PasskeyLogin.tsx → http-relying-party.ts
   │  JSON over HTTPS, same origin, cookies
   ▼
Next.js server (Vercel Functions, or next start)
   ├─ src/instrumentation.ts                 starts the backend before the first request
   ├─ src/app/api/passkey/**/route.ts        the six endpoints (§4)
   ├─ src/lib/server/passkey/http.ts         shared wrapper: Origin check, session cookie → user, errors
   ├─ src/lib/server/passkey/ceremonies.ts   @simplewebauthn/server calls and policy (§7)
   └─ src/lib/server/passkey/database.ts     Postgres via node-postgres (§8)
   │
   ▼
Neon Postgres (pooled connection string)
```

---

## 2. Technology and Configuration

### 2.1 Stack
- **BR-TECH-1** Endpoints are Next.js route handlers (`route.ts`, App Router) inside this app, under `/api/passkey`, on the Node.js runtime. Same origin as the page: no CORS, `SameSite` cookies work, and the RP ID is the site's hostname.
- **BR-TECH-2** WebAuthn ceremonies use `@simplewebauthn/server`. Its option generators return the WebAuthn Level 3 JSON shapes the frontend parses, and its verifiers accept `PublicKeyCredential.toJSON()` output as sent by the frontend.
- **BR-TECH-3** Storage is Postgres — Neon, created through Vercel's integration — reached with `pg` (node-postgres) through a connection pool. On Vercel the pool is registered with `attachDatabasePool` from `@vercel/functions`, so idle connections are closed before a function instance is suspended. The stores see only a small `Db` interface (`query`, `transaction`), so unit tests run the same SQL on PGlite, Postgres compiled to WebAssembly.
- **BR-TECH-4** Server-only code lives under `src/lib/server/`; its entry points import `server-only`, so the build fails if client code imports them. `pg` is on Next.js's default `serverExternalPackages` list, so it is loaded from `node_modules` rather than bundled.
- **BR-TECH-5** No auth framework and no JWTs: a session is a database row plus an opaque cookie (§6).
- **BR-TECH-6** Unit tests use Vitest; end-to-end tests use Playwright with a virtual authenticator (§14).

### 2.2 Configuration

| Variable | Kind | Example | Default | Purpose |
|---|---|---|---|---|
| `DATABASE_URL` | private | `postgresql://…-pooler.…neon.tech/neondb?sslmode=require` | required; `POSTGRES_URL` is read if unset | Postgres connection string. Vercel's Neon integration sets it; `vercel env pull .env.local` copies it for local development |
| `NEXT_PUBLIC_PASSKEY_RP_ID` | public, build time | `example.com` | page hostname | Only when the RP ID is not the page's hostname; used by the frontend for Signal API calls |
| `PASSKEY_ORIGIN` | private | `https://example.com` | on Vercel derived from its variables (BR-CONF-6); `http://localhost:3000` under `pnpm dev`; otherwise required | Expected WebAuthn origin(s) and allowed `Origin` header; comma-separated for several |
| `PASSKEY_RP_ID` | private | `example.com` | hostname of `PASSKEY_ORIGIN` | Relying party ID |
| `PASSKEY_RP_NAME` | private | `creating space` | `creating space` | Shown by some authenticators |
| `SESSION_TTL_DAYS` | private | `30` | `30` | Session lifetime |
| `PASSKEY_CLIENT_IP_HEADER` | private | `x-real-ip` | `x-forwarded-for` | Request header the client IP is read from, for rate limits and logs (BR-SEC-5) |
| `PASSKEY_XFF_DEPTH` | private | `2` | `1` | With `X-Forwarded-For`: the entry counted from the right that holds the client, i.e. the number of proxies |

- **BR-CONF-1** Private settings are read from `process.env` (Next.js loads `.env` and `.env.local`) and validated once at startup, in `register()` of `src/instrumentation.ts`. On a self-hosted server a missing or invalid value MUST stop the process with a clear message, not fail at the first request. On Vercel there is no process to stop: the problems are logged when a function instance starts, and API requests answer `500` until the configuration is fixed. The connection string is never echoed in a message: it holds the password.
- **BR-CONF-2** `PASSKEY_RP_ID` MUST equal the hostname of every `PASSKEY_ORIGIN` or be a registrable parent of it; this is checked at startup (FR-SEC-2).
- **BR-CONF-3** Every environment (dev, preview, production) has its own RP ID and SHOULD have its own database (the Neon integration can create a database branch per preview deployment). Passkeys registered for one RP ID never work on another; this is expected, not a bug.
- **BR-CONF-4** Development uses `PASSKEY_ORIGIN=http://localhost:3000` (`pnpm dev`, also the default in development) or the port actually served. The LAN address printed by `pnpm dev` is not a secure context and cannot be used.
- **BR-CONF-5** Local settings go in `.env` or `.env.local` (both gitignored); a committed `.env.example` lists every variable with safe defaults. On Vercel they are project environment variables.
- **BR-CONF-6** Without `PASSKEY_ORIGIN`, a Vercel deployment uses `https://` + `VERCEL_PROJECT_PRODUCTION_URL` in production (the shortest custom domain, else `<project>.vercel.app`) and `https://` + `VERCEL_BRANCH_URL` (else `VERCEL_URL`) in a preview. A preview has several hostnames under `vercel.app`, and an RP ID cannot be `vercel.app` itself (a public suffix), so passkeys on a preview work on its branch URL only. `vercel env pull` writes these variables empty for development, which then falls back to `http://localhost:3000`.

---

## 3. General API Rules

- **BR-GEN-1** All paths below are relative to `/api/passkey`.
- **BR-GEN-2** POST bodies MUST be `Content-Type: application/json` (a `charset` parameter is allowed). Otherwise → `415 unsupported_media_type`. Bodies larger than 64 KiB → `413 payload_too_large`. Invalid JSON or a body that fails schema validation → `400 invalid_request`. Validation happens before any database or crypto work.
- **BR-GEN-3** Responses are JSON (`Content-Type: application/json`) except `204 No Content`. Every response carries `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
- **BR-GEN-4** Binary values travel as unpadded base64url strings (RFC 4648 §5), never plain base64 (FR-ENC-1). A value that is not valid base64url → `400 invalid_request`.
- **BR-GEN-5** The user object is `{ "id": string, "name": string }`, where `id` is the WebAuthn **user handle** in base64url — never a database row number — and `name` the name generated at registration (BR-REGO-4).
- **BR-GEN-6** Undocumented methods on a documented path → `405` (Next.js's default for methods a route does not export). Next.js also answers `HEAD` with the `GET` handler and `OPTIONS` with `204` and an `Allow` header — without any CORS headers.
- **BR-GEN-7** Success bodies contain at least the fields in §4. Extra fields are allowed and ignored by the frontend.

### 3.1 Errors (FR-API-5)
- **BR-ERR-1** Every non-2xx response has the body `{ "code": string, "message": string }`. `code` is a stable machine value from the table below; `message` is English developer text. The UI never shows `message`, so it MUST NOT contain secrets, tokens, stack traces, SQL or other users' data.
- **BR-ERR-2** Codes, statuses and the text the merged frontend shows for them:

| `code` | Status | Returned when | Frontend shows |
|---|---|---|---|
| `invalid_request` | 400 | Invalid JSON, missing fields, bad base64url, unknown `type` | generic¹ |
| `verification_failed` | 400 | Any WebAuthn check fails; challenge unknown, used, or issued to another browser; credential already registered; user handle mismatch; counter regression | "Your passkey couldn't be verified. Try again." |
| `challenge_expired` | 400 | Challenge issued to this browser but past its expiry | "The request expired. Try again." |
| `forbidden_origin` | 403 | `Origin` header missing or not allowed on POST/DELETE | generic¹ |
| `unknown_credential` | 404 | The assertion's credential ID is not in the database (see BR-ERR-3) | "That passkey isn't registered here any more." + Signal API |
| `payload_too_large` | 413 | Body over 64 KiB | generic¹ |
| `unsupported_media_type` | 415 | POST without `application/json` | generic¹ |
| `unsupported_authenticator` | 422 | Public key algorithm not offered, or the key cannot be parsed | "This authenticator can't be used here. Try another one." |
| `rate_limited` | 429 | Rate limit hit (§9); includes `Retry-After` | "Too many attempts. Wait a minute and try again." |
| `internal_error` | 500 | Anything unexpected | generic¹ |

¹ "Something went wrong with passkeys. Try again."

- **BR-ERR-3** `unknown_credential` is reserved for exactly one case: the credential ID is not stored. The frontend reacts by calling `PublicKeyCredential.signalUnknownCredential()`, which makes password managers hide or delete that passkey. A database error, a timeout or a bad signature MUST NEVER be reported as `unknown_credential`.
- **BR-ERR-4** Unexpected exceptions → `500 internal_error`. The error is logged with a request ID, and the response `message` contains only that ID.
- **BR-ERR-5** In production, `verification_failed` messages stay coarse ("Credential could not be verified"); the precise failed check goes to the server log.

---

## 4. Endpoints (FR-API-1…4)

### 4.1 `POST /registration/options`
Starts a registration, which always creates a **new account**. Request: `{}` — the body is ignored (any `userName` or `displayName` in it too) but MUST still be JSON (BR-GEN-2).

- **BR-REGO-4** A *pending* account is prepared: a fresh 32-byte random user handle and a generated name, `Traveller ` followed by six random characters from Crockford's base32 alphabet (e.g. `Traveller 7K3QX2`). The name is what the passkey picker lists, so two accounts on one device can be told apart; it need not be unique. The pending account is stored only with the challenge (§5), not in `users`, so requesting options creates nothing.
- **BR-REGO-5** A signed-in caller also gets a new account; on verification the session moves to it (BR-COOK-4). The frontend only offers "Create a passkey" while signed out.
- **BR-REGO-6** The user handle MUST NOT be derived from the name, email or any personal data (WebAuthn privacy requirement).
- **BR-REGO-7** Response `200` — `PublicKeyCredentialCreationOptionsJSON`:

| Field | Value |
|---|---|
| `rp` | `{ "id": PASSKEY_RP_ID, "name": PASSKEY_RP_NAME }` |
| `user` | `{ "id": <handle>, "name": <generated name>, "displayName": <generated name> }` |
| `challenge` | New challenge (§5) |
| `pubKeyCredParams` | MUST include ES256 (`-7`) and RS256 (`-257`); MAY list EdDSA (`-8`) first |
| `timeout` | `300000` |
| `excludeCredentials` | The device cookie's passkeys that still exist, as `{ "type": "public-key", "id", "transports" }` (BR-REGO-9); usually `[]` |
| `authenticatorSelection` | `{ "residentKey": "required", "requireResidentKey": true, "userVerification": "preferred" }` — discoverable, so sign-in needs no username; no `authenticatorAttachment`, so phones and security keys stay possible (FR-OPT-3) |
| `attestation` | `"none"` |
| `extensions` | MAY be `{ "credProps": true }`; nothing may depend on it, because the frontend's fallback parser drops extensions |
| `hints` | Omitted |

- **BR-REGO-8** Issues the challenge and sets the flow cookie (§5, §6.2).
- **BR-REGO-9** One passkey per device. WebAuthn lets no site ask a device which passkeys it holds; only an authenticator shown a credential ID can say it has that one. So the browser keeps the IDs of the passkeys it created or signed in with in the device cookie (BR-COOK-10), and the options list those that still exist in `excludeCredentials`. An authenticator holding one of them refuses to create another: `create()` fails with `InvalidStateError`, which the frontend shows as "This device already has a passkey here. Sign in with it instead." IDs no longer in the database are left out and removed from the cookie, so a deleted account never blocks a new passkey. The rule holds per browser: another browser, or one whose site data was cleared, does not know the passkey and may create one — WebAuthn gives no way to find out.

### 4.2 `POST /registration/verify`
Finishes a registration. Request: the registration credential as produced by `toJSON()`:

```json
{
  "id": "<base64url>", "rawId": "<base64url>", "type": "public-key",
  "authenticatorAttachment": "platform",
  "clientExtensionResults": {},
  "response": {
    "clientDataJSON": "<base64url>", "attestationObject": "<base64url>",
    "authenticatorData": "<base64url>", "transports": ["internal", "hybrid"],
    "publicKey": "<base64url>", "publicKeyAlgorithm": -7
  }
}
```

- **BR-REGV-1** Schema: `id` and `rawId` are equal base64url strings; `type` is `"public-key"`; `clientDataJSON` and `attestationObject` are base64url. `transports` is optional; unknown values are dropped (known: `usb`, `nfc`, `ble`, `smart-card`, `hybrid`, `internal`). `authenticatorData`, `publicKey` and `publicKeyAlgorithm` are informational: the backend MUST take the key and flags from `attestationObject`, not from these fields.
- **BR-REGV-2** The challenge is read from `clientDataJSON` and redeemed (§5); it MUST be a registration challenge. It is used up even if a later step fails.
- **BR-REGV-4** Verification follows §7.1.
- **BR-REGV-5** A credential ID that is already stored (for any user) → `400 verification_failed`.
- **BR-REGV-6** In one transaction: insert the pending account, insert the credential (§8) with its transports (FR-ENC-4), and create a session (§6), replacing any session the request carried.
- **BR-REGV-7** Response `200 { "user": User }` plus the session cookie.

### 4.3 `POST /authentication/options`
Request: `{}`. The body is ignored but MUST still be JSON (BR-GEN-2). No session needed.

- **BR-AUTHO-1** Response `200` — `PublicKeyCredentialRequestOptionsJSON`: `challenge` (§5), `rpId`, `allowCredentials: []`, `userVerification: "preferred"`, `timeout: 300000`. The empty `allowCredentials` makes any discoverable passkey for this RP eligible, so the user needs no username: the browser lists the device's passkeys and the chosen one names its account (BR-AUTHV-4).
- **BR-AUTHO-2** The response never depends on user input, so it reveals nothing about which accounts exist.
- **BR-AUTHO-3** The frontend calls this when the user clicks "Sign in with a passkey", right before opening the prompt. There is no autofill (conditional UI): with no username field there is nowhere to offer it.

### 4.4 `POST /authentication/verify`
Request: the assertion as produced by `toJSON()` (`id`, `rawId`, `type`, `authenticatorAttachment`, `clientExtensionResults`, `response.clientDataJSON`, `response.authenticatorData`, `response.signature`, `response.userHandle`).

- **BR-AUTHV-1** Schema: `id` equals `rawId`; `clientDataJSON`, `authenticatorData`, `signature` and `userHandle` are base64url.
- **BR-AUTHV-2** The challenge is redeemed (§5); it MUST be an authentication challenge.
- **BR-AUTHV-3** The credential is looked up by `id`. Not found → `404 unknown_credential` (BR-ERR-3).
- **BR-AUTHV-4** `userHandle` MUST be present (the options had an empty `allowCredentials`) and MUST equal the owning user's handle. Otherwise → `400 verification_failed`. `@simplewebauthn/server` does not check this.
- **BR-AUTHV-5** Verification follows §7.2, using the stored public key and counter.
- **BR-AUTHV-6** On success, in one transaction: update the counter, the backed-up flag and `last_used_at`, and create a session (§6), replacing any session the request carried.
- **BR-AUTHV-7** Response `200 { "user": User }` plus the session cookie.

### 4.5 `GET /session`
- **BR-SES-1** Always `200`: `{ "user": User | null, "devicePasskey": boolean }` — `user` for a live session, otherwise `null`. Never `401` — the frontend calls this on every page load and would show an error. It shows no buttons until this answers, so without a session cookie it answers without touching the database (BR-OPS-1).
- **BR-SES-6** `devicePasskey` is true when the device cookie names any passkey (BR-COOK-10), read from the cookie alone. Signed out, the frontend then offers only "Sign in with a passkey"; "Create a passkey" returns after a failed sign-in, for someone whose passkey is gone — BR-REGO-9 still stops a second one if it is not.
- **BR-SES-2** An unknown or expired session cookie is cleared in the response.
- **BR-SES-3** MAY extend the session (sliding expiry, BR-COOK-5).

### 4.6 `DELETE /session`
- **BR-SES-4** Deletes the session row and clears the cookie. Idempotent: `204` whether or not a session existed.
- **BR-SES-5** MUST answer `204 No Content` without a body. The frontend treats a `200` without a JSON body as an invalid response.

---

## 5. Challenges (FR-SEC-3)

- **BR-CH-1** 32 bytes from a cryptographically secure generator, encoded base64url.
- **BR-CH-2** Stored server-side with: type (`registration` / `authentication`), flow ID, pending account (handle and generated name — registration only), created and expiry times.
- **BR-CH-3** Bound to the browser: the options endpoints set a flow cookie (§6.2) if it is missing, and a challenge can only be redeemed by a request carrying the same flow ID. A challenge obtained in one browser is useless in another.
- **BR-CH-4** A challenge lives for the ceremony timeout (300 s) plus 30 s for the verify request.
- **BR-CH-5** Single use: redeeming deletes the row atomically (e.g. `DELETE … RETURNING`) **before** any cryptographic verification, so a replayed or failing response can never use it again.
- **BR-CH-6** Redeem outcomes: not found, already used, other flow or wrong type → `400 verification_failed`; found but expired → `400 challenge_expired`.
- **BR-CH-7** Several outstanding challenges per flow are allowed (a retry, a second tab). At most 5 are kept per flow; issuing a sixth drops the oldest.
- **BR-CH-8** Expired rows are kept for one hour, so a late answer (e.g. from a laptop that slept with the prompt open) is told `challenge_expired`, and then removed by the periodic cleanup (BR-OPS-2).
- **BR-CH-9** Challenge values are never logged.

---

## 6. Sessions and Cookies (FR-AUTH-5, FR-SEC-5)

### 6.1 Session cookie
- **BR-COOK-1** Name `__Host-passkey-session` in production. Over `http://localhost` in development the name is `passkey-session` without `Secure`, because not every browser accepts `Secure` cookies on plain http. Cookies are not separated by port, so the name is specific enough not to clash with other apps on localhost.
- **BR-COOK-2** Attributes: `HttpOnly`, `Secure` (production), `SameSite=Lax`, `Path=/`, `Expires` = the session's expiry. No `Domain`.
- **BR-COOK-3** Value: 32 random bytes, base64url. The database stores only the SHA-256 of the token, so a database leak does not expose usable sessions.
- **BR-COOK-4** Rotation: every successful registration or authentication creates a new session and deletes the one the request carried (prevents session fixation).
- **BR-COOK-5** Lifetime `SESSION_TTL_DAYS` (default 30). Sliding: when less than half remains, the expiry is extended and the cookie re-sent.
- **BR-COOK-6** The endpoint wrapper (`http.ts`) resolves the cookie on every API request into the request context's `user` (or `null`), clearing a cookie whose session is unknown or expired. Endpoints read the user only from that context.
- **BR-COOK-7** Sessions record created, expiry and last-seen times (last-seen updated at most once per hour) and MAY record the user agent for a future "signed-in devices" list.
- **BR-COOK-8** Tokens never appear in response bodies, URLs or logs. The frontend stores no secret anywhere.

### 6.2 Flow cookie
- **BR-COOK-9** Name `__Host-passkey-flow` (development: `passkey-flow`, no `Secure`); `HttpOnly`, `SameSite=Strict`, `Path=/`; value 16 random bytes, base64url; `Max-Age` one day, refreshed whenever options are issued — longer than the challenges, so it is still present when a late answer arrives (BR-CH-8). It only links challenges to a browser and grants no access by itself.

### 6.3 Device cookie
- **BR-COOK-10** Name `__Host-passkey-device` (development: `passkey-device`, no `Secure`); `HttpOnly`, `SameSite=Strict`, `Path=/`, `Max-Age` 400 days (the most browsers keep a cookie). Value: up to 5 credential IDs, newest first, joined with `.`. Set by both verify endpoints with the passkey just used, and kept on sign-out — that is its purpose. The client can edit it, so it is parsed strictly and only ever used to exclude passkeys that exist, which can only stop the sender from making a passkey. It does link the browser to its accounts after sign-out, which is the price of recognizing the device.

---

## 7. WebAuthn Verification

`@simplewebauthn/server` performs most checks below; the backend configures it to match this policy and adds what it leaves out (marked **backend**).

### 7.1 Registration (WebAuthn §7.1)
- **BR-WA-1** `clientDataJSON.type` is `"webauthn.create"`.
- **BR-WA-2** `clientDataJSON.challenge` equals the redeemed challenge.
- **BR-WA-3** `clientDataJSON.origin` is one of `PASSKEY_ORIGIN`; `crossOrigin` is not `true` (no iframe embedding).
- **BR-WA-4** `rpIdHash` equals SHA-256 of `PASSKEY_RP_ID`.
- **BR-WA-5** User Present flag set. User Verified is **not** required (`userVerification: "preferred"`): the library requires it by default, so `requireUserVerification` MUST be set to `false`. The UV bit is recorded.
- **BR-WA-6** Attested credential data present; credential ID at most 1023 bytes and equal to `id` (**backend** compares with the request).
- **BR-WA-7** Public key algorithm is one of those offered in `pubKeyCredParams`; otherwise → `422 unsupported_authenticator`.
- **BR-WA-8** Attestation format `none` is accepted; other formats are accepted without verifying the statement (no AAGUID allow-list in this project). The AAGUID is stored.
- **BR-WA-9** Backup flags: Backup State without Backup Eligible is invalid → `verification_failed`. Both flags are stored.
- **BR-WA-10** Unrequested extension outputs are ignored.

### 7.2 Authentication (WebAuthn §7.2)
- **BR-WA-11** `clientDataJSON.type` is `"webauthn.get"`; challenge, origin, `crossOrigin` and `rpIdHash` checked as in BR-WA-2…4.
- **BR-WA-12** User Present set; User Verified not required (`requireUserVerification: false`).
- **BR-WA-13** **Backend:** `userHandle` matches the credential's owner (BR-AUTHV-4).
- **BR-WA-14** The signature over `authenticatorData ‖ SHA-256(clientDataJSON)` verifies with the stored public key.
- **BR-WA-15** Sign counter: if the stored or the received counter is non-zero, the received one MUST be greater, otherwise → `verification_failed` and a `counter_regression` security log entry (possible cloned authenticator). `0`/`0` — typical for synced passkeys — is fine. The comparison runs only after the signature verified (so unauthenticated requests cannot trigger the log entry) and as one compare-and-set update (so concurrent sign-ins cannot lower the stored counter).
- **BR-WA-16** Backup Eligible MUST NOT change from its stored value; Backup State may change and is updated.

### 7.3 Policy summary

| Setting | Value |
|---|---|
| RP ID / name | `PASSKEY_RP_ID` / `PASSKEY_RP_NAME` |
| Algorithms | EdDSA (-8, optional), ES256 (-7), RS256 (-257) |
| Timeout | 300 000 ms |
| Resident key | required |
| User verification | preferred (not enforced) |
| Attestation | none |
| Authenticator attachment | not restricted |

---

## 8. Data Model

Postgres. Times are `timestamptz`; the application passes its own clock's time, so tests can control it. Foreign keys cascade on delete.

| Table | Column | Type | Notes |
|---|---|---|---|
| `users` | `id` | text PK | User handle, base64url (BR-GEN-5) |
| | `name` | text | Generated (BR-REGO-4); not unique |
| | `created_at` | timestamptz | |
| `credentials` | `id` | text PK | Credential ID, base64url |
| | `user_id` | text FK → `users.id` | Indexed |
| | `public_key` | bytea | COSE key as returned by verification |
| | `algorithm` | integer | COSE algorithm ID |
| | `counter` | bigint | Sign counter, unsigned 32-bit |
| | `transports` | text[] | FR-ENC-4 |
| | `aaguid` | text | Authenticator model, for naming passkeys later |
| | `backup_eligible`, `backed_up` | boolean | |
| | `created_at` | timestamptz | |
| | `last_used_at` | timestamptz NULL | |
| `sessions` | `token_hash` | text PK | SHA-256 of the cookie token |
| | `user_id` | text FK → `users.id` | Indexed |
| | `created_at`, `expires_at`, `last_seen_at` | timestamptz | `expires_at` indexed |
| | `user_agent` | text NULL | Optional |
| `challenges` | `challenge` | text PK | base64url |
| | `seq` | bigint identity | Issue order, for the per-flow cap (BR-CH-7) |
| | `flow_id` | text | Indexed with `seq` |
| | `type` | text | `registration` / `authentication` |
| | `user_id`, `user_name` | text NULL | Pending account (registration) |
| | `created_at`, `expires_at` | timestamptz | `expires_at` indexed |
| `rate_limits` | `key` | text PK | Endpoint group and client address (BR-SEC-5) |
| | `count` | integer | Requests in the current window |
| | `reset_at` | timestamptz | End of the window; indexed |
| `schema_migrations` | `version` | integer PK | Applied migrations (BR-DATA-2) |

- **BR-DATA-1** The app connects with Neon's *pooled* connection string (host name ending in `-pooler`), which serves many short-lived function instances. That pooler runs in transaction mode, so nothing may depend on session state: no session-level advisory locks, `SET` or `LISTEN`. Every value is a query parameter, never spliced into SQL.
- **BR-DATA-2** Schema changes are numbered SQL migrations, applied in order when the backend starts and recorded in `schema_migrations`. They run in one transaction under a transaction-level advisory lock, so instances starting together (every cold start on Vercel) wait for each other and a failed migration leaves nothing behind. A database migrated by newer code is refused.
- **BR-DATA-3** `sslmode=require` in Neon's connection string is sent as `sslmode=verify-full`: what node-postgres already does for `require`, without its deprecation warning. Neon's certificates are publicly trusted.
- **BR-DATA-4** Every multi-row write is a single transaction; unique-constraint violations are mapped to the error codes in §4, never surfaced as `500`.

---

## 9. Security

- **BR-SEC-1** Production is HTTPS only (TLS at the proxy) with HSTS. Development uses `localhost` only (FR-SEC-1).
- **BR-SEC-2** Every POST and DELETE MUST carry an `Origin` header equal to one of `PASSKEY_ORIGIN`, otherwise → `403 forbidden_origin`. Browsers send `Origin` on all non-GET fetches, including same-origin ones.
- **BR-SEC-3** CSRF (FR-SEC-6): state changes need JSON POST or DELETE, which a cross-site page cannot send without a CORS preflight; the backend answers no preflight, `SameSite` cookies are not sent cross-site, and BR-SEC-2 checks the origin anyway. The app has no form actions or Server Actions, so no other endpoint accepts form posts.
- **BR-SEC-4** No CORS headers while the API is same-origin. If the API is ever split off: an exact origin allow-list, `Access-Control-Allow-Credentials: true`, methods `GET, POST, DELETE`, header `Content-Type` — never `*`.
- **BR-SEC-5** Rate limits per client IP: options endpoints 30/min, verify endpoints 10/min. The counts live in the `rate_limits` table, updated with one atomic upsert per request, because on Vercel consecutive requests may reach different function instances. Excess → `429 rate_limited` with `Retry-After`. A route handler cannot see the connection, so the IP comes from a header (BR-OPS-4).
- **BR-SEC-6** Account enumeration: no endpoint takes a name, and `/authentication/options` is the same for everyone, so nothing reveals which accounts exist.
- **BR-SEC-7** The server never sees private keys (FR-SEC-4); session tokens are stored only as hashes; no secret is ever returned in a body.
- **BR-SEC-8** Security events are logged as structured JSON with request ID, user handle, credential ID, IP and user agent: registration, sign-in success and failure (with the failed check), `counter_regression`, `unknown_credential`, sign-out, rate limiting. Cookies, tokens, challenges and full credential payloads are never logged.
- **BR-SEC-9** Strict schema validation and size limits (BR-GEN-2) run before any lookup or crypto.
- **BR-SEC-10** `@simplewebauthn/server` is pinned to a major version and updated for security releases.

---

## 10. Operations

- **BR-OPS-1** Startup validates the configuration. A self-hosted server then connects to the database and runs the migrations before accepting requests, and stops on invalid configuration (BR-CONF-1). On Vercel, Next.js holds back the first request of every cold start until startup is done, so startup does not wait for the database there: the first query connects and migrates, and if that fails, the next one tries again. `GET /session` without a session cookie needs no database at all, so a signed-out visitor never waits for the connection — nor wakes a suspended Neon database.
- **BR-OPS-2** Expired challenges (after BR-CH-8's retention), sessions and rate-limit windows are deleted at most every 10 minutes per instance. There is no timer — a Vercel function only runs while it serves requests — so a POST or DELETE request (which uses the database anyway) schedules the cleanup with Next.js's `after()`, which runs it once the response has been sent. A failure is logged and never affects a response.
- **BR-OPS-3** The database is Neon's: it keeps a restore history for point-in-time recovery, as long as the plan allows. Losing the data orphans every passkey.
- **BR-OPS-4** The client address comes from `X-Forwarded-For`. On Vercel that header holds the client's address, set by Vercel itself, so the default (the rightmost entry) is right. A self-hosted server runs behind a reverse proxy that appends the client address to it: Next.js fills the header from the connection only when a request has none, so without a proxy a client can choose its own rate-limit key. With several proxies `PASSKEY_XFF_DEPTH` is their number; a proxy that sets another header (e.g. `X-Real-IP`) is used through `PASSKEY_CLIENT_IP_HEADER`. Origin checks do not depend on the proxy: they compare against `PASSKEY_ORIGIN`.
- **BR-OPS-5** Any number of instances may run at once: all state is in Postgres. Per instance there is only the connection pool and the time of the last cleanup.
- **BR-OPS-6** The service worker (`public/service-worker.js`) only caches page navigations, `/_next/static/*` and `/favicon/*`; it skips `/api/*` entirely, so API responses are never served from a cache. This MUST stay true.
- **BR-OPS-7** `GET /api/health` answers `200 { "ok": true }` after a trivial database query, or `503 { "ok": false }`. Neon suspends an idle database and bills the time it runs, so a monitor calling this every minute keeps it awake.

---

## 11. Frontend Integration Checklist

What the merged frontend relies on; each item is also a requirement above.

- The API is at `/api/passkey` on the page's own origin.
- Requests use `credentials: "include"` and `cache: "no-store"`; POSTs send JSON; GET and DELETE send no body.
- Verify endpoints and `GET /session` wrap the user as `{ "user": … }`; `GET /session` is always `200` (BR-SES-1).
- DELETE endpoints answer exactly `204` (BR-SES-5).
- Errors are `{ code, message }`; unknown codes show a generic message (BR-ERR-2).
- `user.id` is the WebAuthn user handle (BR-GEN-5); `unknown_credential` triggers the Signal API (BR-ERR-3).
- Registration options are requested with `{}`; the backend names the account (BR-REGO-4).
- `GET /session` also answers `devicePasskey`; `InvalidStateError` from `create()` means this device already has a passkey (BR-REGO-9, BR-SES-6).
- `NEXT_PUBLIC_PASSKEY_RP_ID` is only needed when the RP ID is not the page's hostname.

---

## 12. Frontend Follow-ups (not required for go-live)

- Map `invalid_request` and `forbidden_origin` to specific messages.
- Render the signed-in state on the server (a Server Component reading the session cookie) instead of after hydration.
- Passkey management UI once the §13 endpoints exist.

---

## 13. Future Extensions (not part of this contract yet)

- **Passkey management (FR-OPT-1):** `GET /credentials` → `{ "credentials": [{ "id", "name", "createdAt", "lastUsedAt", "backedUp", "transports" }] }`; `PATCH /credentials/:id` `{ "name" }`; `DELETE /credentials/:id`, refusing the last passkey with `409 last_credential`. After a change the frontend calls `signalAllAcceptedCredentials` with the remaining IDs.
- **Add a passkey / delete the account:** both were removed with usernames. Brought back, adding a passkey needs `excludeCredentials` and a check that the session that asked for the options still owns the challenge; deleting an account needs a recent sign-in (`403 reauthentication_required`) and `signalAllAcceptedCredentials` with an empty list afterwards.
- **Account recovery / fallback sign-in (FR-OPT-5):** e.g. an email magic link. Without it, a user who loses every passkey loses the account.
- **Related origins:** `/.well-known/webauthn` if the site ever runs on several domains.
- **Accounts from the old in-browser mode are not migrated.** A backend must not trust public keys reported by the browser without a registration ceremony; users register again.

---

## 14. Testing

- **BR-TEST-1** Unit tests (Vitest, on PGlite) cover: the device cookie's parsing and limits; configuration, including the Vercel origin and the database URL; migrations; generated names; credential storage round-trips and transaction rollback; challenge issue, redeem, expiry, single use, flow binding and the per-flow cap; session hashing, sliding expiry and expiry cleanup; rate limits, also under concurrency; error-to-status mapping; counter logic.
- **BR-TEST-2** End-to-end tests (Playwright with a Chrome DevTools Protocol virtual authenticator, FR-TEST-3) run against `pnpm build && pnpm start` on a throwaway Postgres database named by `E2E_DATABASE_URL`, and cover every flow in FR-TEST-4:
  - register, reload (still signed in), sign out, sign in with the button;
  - no input fields; signed in, "Sign out" is the only button;
  - nothing is shown until `GET /session` answers;
  - one passkey per device: after sign-out only sign-in is offered, the options exclude the device's passkey, and a second `create()` is refused with `InvalidStateError`;
  - a device whose passkey was deleted from the authenticator can create a new one (a new account);
  - sign in when the authenticator has no passkey → neutral message;
  - credential deleted from the database → `404 unknown_credential`, and the virtual authenticator loses the passkey through the Signal API.
- **BR-TEST-3** Negative security tests: replayed assertion; challenge from another flow cookie; expired challenge (fake clock) → `challenge_expired`; tampered signature; `userHandle` of another user; counter regression; wrong `Origin` → `403`; `text/plain` POST → `415`; oversized body → `413`; rate limit → `429`; registration ignores a client-supplied name; a forged device cookie excludes nothing; a signed-out session token is rejected server-side; cookie attributes asserted.
- **BR-TEST-4** Manual checks: Chrome, Safari and Firefox; a platform authenticator and a security key; the real deployed domain (FR-TEST-1, -2, -5).

---

## 15. Traceability

| Frontend requirement | Covered by |
|---|---|
| FR-REG-2 fresh registration options | BR-REGO-4…8, §5 |
| FR-REG-4 verify and store credential | BR-REGV-1…7, §7.1, §8 |
| FR-AUTH-2 fresh authentication options | BR-AUTHO-1…3, §5 |
| FR-AUTH-4/5 verify assertion, session | BR-AUTHV-1…7, §6 |
| FR-COND-2/3 autofill | Not offered: there is no username field (BR-AUTHO-3) |
| FR-ENC-1 base64url | BR-GEN-4 |
| FR-ENC-4 transports | BR-REGV-1, `credentials.transports` |
| FR-ERR-2 username taken before `create()` | Not applicable: no usernames (BR-REGO-4) |
| FR-SEC-1 secure context | BR-SEC-1, BR-CONF-4 |
| FR-SEC-2 RP ID per environment | BR-CONF-2, BR-CONF-3 |
| FR-SEC-3 server challenges | BR-CH-1…9 |
| FR-SEC-4 no private keys | BR-SEC-7 |
| FR-SEC-5 httpOnly session cookie | BR-COOK-1…8 |
| FR-SEC-6 CSRF | BR-SEC-2, BR-SEC-3 |
| FR-API-1…4 endpoints | §4 |
| FR-API-5 error shape | BR-ERR-1…5 |
| FR-OPT-1 passkey management | §13 (future) |
| FR-OPT-2 add a passkey | Not offered (§13) |
| FR-OPT-3 cross-device | BR-REGO-7 (no `authenticatorAttachment`) |
| FR-OPT-4 Signal API | BR-ERR-3 |
| FR-TEST-1…5 | §14 |

---

## 16. Definition of Done

- All six endpoints behave as in §4, with §5–§9 enforced.
- The frontend signs up and signs in against the backend, on Vercel with Neon.
- BR-TEST-1…3 pass locally; BR-TEST-4 has been done once on the deployed domain.
- `pnpm check`, `pnpm lint` and `pnpm build` are clean.
- The README's backend contract, `.env.example` and this document agree; any divergence is fixed in all three.
