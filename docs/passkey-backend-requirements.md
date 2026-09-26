# Passkey Login — Backend Requirements

Pet project goal: replace the in-browser relying party with a real backend, so challenges, passkeys and sessions live on a server.
Scope: backend only, technical requirements, no implementation code.
Related: `passkey-frontend-requirements.md` (the `FR-*` IDs referenced below), the README section "Passkeys → Backend contract", and the client that calls this API, `src/lib/passkey/http-relying-party.ts`.

The words **MUST**, **SHOULD** and **MAY** are used as in RFC 2119.

---

## 1. Context

- The frontend on `master` already implements the client side of the contract. Setting `PUBLIC_PASSKEY_API_URL` switches it from the in-browser relying party (`localStorage`) to this backend. Going live needs **no frontend code change**; §12 lists optional follow-ups.
- The backend owns everything security-relevant: challenges, attestation and assertion verification, credential storage, accounts and sessions. The frontend only forwards opaque WebAuthn data.

```
Browser ── PasskeyLogin.svelte → http-relying-party.ts
   │  JSON over HTTPS, same origin, cookies
   ▼
SvelteKit server (adapter-node)
   ├─ src/hooks.server.ts             session cookie → event.locals.user
   ├─ src/routes/api/passkey/**       the seven endpoints (§4)
   ├─ src/lib/server/webauthn/        @simplewebauthn/server wrappers, policy (§7)
   └─ src/lib/server/db/              SQLite via better-sqlite3 (§8)
```

---

## 2. Technology and Configuration

### 2.1 Stack
- **BR-TECH-1** Endpoints are SvelteKit server routes (`+server.ts`) inside this app, under `/api/passkey`. Same origin as the page: no CORS, `SameSite` cookies work, and the RP ID is the site's hostname.
- **BR-TECH-2** WebAuthn ceremonies use `@simplewebauthn/server`. Its option generators return the WebAuthn Level 3 JSON shapes the frontend parses, and its verifiers accept `PublicKeyCredential.toJSON()` output as sent by the frontend.
- **BR-TECH-3** Storage is SQLite through `better-sqlite3` (synchronous, transactional, one file). pnpm only runs build scripts for allow-listed packages, so `better-sqlite3` MUST be added to `onlyBuiltDependencies` / `allowBuilds` in `pnpm-workspace.yaml`, or its native module is never compiled.
- **BR-TECH-4** Server-only code lives under `src/lib/server/`, which SvelteKit refuses to bundle into client code.
- **BR-TECH-5** No auth framework and no JWTs: a session is a database row plus an opaque cookie (§6).
- **BR-TECH-6** Unit tests use Vitest (Vite-native); end-to-end tests use Playwright with a virtual authenticator (§14).

### 2.2 Configuration

| Variable | Kind | Example | Default | Purpose |
|---|---|---|---|---|
| `PUBLIC_PASSKEY_API_URL` | public, runtime | `/api/passkey` | unset → local mode | Switches the frontend to a backend; the built-in one starts only when this is `/api/passkey` (BR-CONF-6) |
| `PUBLIC_PASSKEY_RP_ID` | public, runtime | `example.com` | page hostname | Only when the RP ID is not the page's hostname; used by the frontend for Signal API calls |
| `PASSKEY_ORIGIN` | private | `https://example.com` | `ORIGIN`; `http://localhost:3000` under `pnpm dev` | Expected WebAuthn origin(s) and allowed `Origin` header; comma-separated for several |
| `PASSKEY_RP_ID` | private | `example.com` | hostname of `PASSKEY_ORIGIN` | Relying party ID |
| `PASSKEY_RP_NAME` | private | `creating space` | `creating space` | Shown by some authenticators |
| `DATABASE_PATH` | private | `data/passkeys.sqlite` | `data/passkeys.sqlite` | SQLite file |
| `SESSION_TTL_DAYS` | private | `30` | `30` | Session lifetime |
| `ORIGIN`, `PROTOCOL_HEADER`, `HOST_HEADER`, `ADDRESS_HEADER` | adapter-node | | | Correct request URL and client IP behind a proxy (§10) |

- **BR-CONF-1** Private settings are read through `$env/dynamic/private` and validated once at startup. A missing or invalid value MUST stop the server with a clear message, not fail at the first request.
- **BR-CONF-2** `PASSKEY_RP_ID` MUST equal the hostname of every `PASSKEY_ORIGIN` or be a registrable parent of it; this is checked at startup (FR-SEC-2).
- **BR-CONF-3** Every environment (dev, staging, prod) has its own RP ID and database. Passkeys registered for one RP ID never work on another; this is expected, not a bug.
- **BR-CONF-4** Development uses `PASSKEY_ORIGIN=http://localhost:3000` (`pnpm dev`, also the default in development) or the port actually served. The LAN address printed by `pnpm dev` is not a secure context and cannot be used.
- **BR-CONF-5** Local settings go in `.env` (gitignored); a committed `.env.example` lists every variable with safe defaults. `data/` is gitignored.
- **BR-CONF-6** The built-in backend starts only when `PUBLIC_PASSKEY_API_URL` is `/api/passkey`. Otherwise the frontend runs in local mode, the server needs no passkey configuration or database, and `/api/passkey/*` answers `404 not_found`.

---

## 3. General API Rules

- **BR-GEN-1** All paths below are relative to `/api/passkey`.
- **BR-GEN-2** POST bodies MUST be `Content-Type: application/json` (a `charset` parameter is allowed). Otherwise → `415 unsupported_media_type`. Bodies larger than 64 KiB → `413 payload_too_large`. Invalid JSON or a body that fails schema validation → `400 invalid_request`. Validation happens before any database or crypto work.
- **BR-GEN-3** Responses are JSON (`Content-Type: application/json`) except `204 No Content`. Every response carries `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
- **BR-GEN-4** Binary values travel as unpadded base64url strings (RFC 4648 §5), never plain base64 (FR-ENC-1). A value that is not valid base64url → `400 invalid_request`.
- **BR-GEN-5** The user object is `{ "id": string, "name": string, "displayName": string }`, where `id` is the WebAuthn **user handle** in base64url — never a database row number. The frontend passes it to `PublicKeyCredential.signalAllAcceptedCredentials()`, which only works with the real handle.
- **BR-GEN-6** Undocumented methods on a documented path → `405` with an `Allow` header (SvelteKit's default for missing handlers).
- **BR-GEN-7** Success bodies contain at least the fields in §4. Extra fields are allowed and ignored by the frontend.

### 3.1 Errors (FR-API-5)
- **BR-ERR-1** Every non-2xx response has the body `{ "code": string, "message": string }`. `code` is a stable machine value from the table below; `message` is English developer text. The UI never shows `message`, so it MUST NOT contain secrets, tokens, stack traces, SQL or other users' data.
- **BR-ERR-2** Codes, statuses and the text the merged frontend shows for them:

| `code` | Status | Returned when | Frontend shows |
|---|---|---|---|
| `invalid_request` | 400 | Invalid JSON, missing fields, bad base64url, unknown `type` | generic¹ |
| `invalid_username` | 400 | Username empty, too long, control characters; or a different name while adding a passkey | "Enter a username to create a passkey." |
| `verification_failed` | 400 | Any WebAuthn check fails; challenge unknown, used, or issued to another browser; credential already registered; user handle mismatch; counter regression | "Your passkey couldn't be verified. Try again." |
| `challenge_expired` | 400 | Challenge issued to this browser but past its expiry | "The request expired. Try again." |
| `not_signed_in` | 401 | `DELETE /account` without a valid session; session changed during "add a passkey" | "Your session has ended. Sign in again." |
| `forbidden_origin` | 403 | `Origin` header missing or not allowed on POST/DELETE | generic¹ |
| `unknown_credential` | 404 | The assertion's credential ID is not in the database (see BR-ERR-3) | "That passkey isn't registered here any more." + Signal API |
| `not_found` | 404 | The built-in backend is off (BR-CONF-6) | generic¹ |
| `username_taken` | 409 | The name belongs to another account | "That username is taken. Pick another one." |
| `payload_too_large` | 413 | Body over 64 KiB | generic¹ |
| `unsupported_media_type` | 415 | POST without `application/json` | generic¹ |
| `unsupported_authenticator` | 422 | Public key algorithm not offered, or the key cannot be parsed | "This authenticator can't be used here. Try another one." |
| `rate_limited` | 429 | Rate limit hit (§9); includes `Retry-After` | generic¹ |
| `internal_error` | 500 | Anything unexpected | generic¹ |

¹ "Something went wrong with passkeys. Try again."

- **BR-ERR-3** `unknown_credential` is reserved for exactly one case: the credential ID is not stored. The frontend reacts by calling `PublicKeyCredential.signalUnknownCredential()`, which makes password managers hide or delete that passkey. A database error, a timeout or a bad signature MUST NEVER be reported as `unknown_credential`.
- **BR-ERR-4** Unexpected exceptions → `500 internal_error`. The error is logged with a request ID, and the response `message` contains only that ID.
- **BR-ERR-5** In production, `verification_failed` messages stay coarse ("Credential could not be verified"); the precise failed check goes to the server log.

---

## 4. Endpoints (FR-API-1…4)

### 4.1 `POST /registration/options`
Starts a registration. Works signed out (new account) and signed in (add a passkey to the current account, FR-OPT-2).

Request: `{ "userName": string, "displayName"?: string }`. The frontend omits `displayName` when it is empty, and sends only `{ "userName": <account name> }` when adding a passkey.

- **BR-REGO-1** `userName`: trimmed, Unicode NFC-normalized, 1–64 UTF-8 bytes (authenticators may truncate longer names), no control characters (Unicode `Cc`). Email addresses are allowed. Otherwise → `400 invalid_username`.
- **BR-REGO-2** Names are unique case-insensitively (compared lower-cased after NFC, the same rule as the frontend's local mode). The name is stored as first entered.
- **BR-REGO-3** `displayName`: optional; trimmed, NFC, at most 64 UTF-8 bytes, no control characters; empty or missing → the username. Invalid → `400 invalid_request`.
- **BR-REGO-4** Signed out: if the name belongs to an account → `409 username_taken`. This happens before any authenticator prompt (FR-ERR-2). Otherwise a *pending* user is prepared: a fresh 32-byte random user handle, the name and the display name. The pending user is stored only with the challenge (§5), not in `users`, so requesting options cannot reserve a name.
- **BR-REGO-5** Signed in: the options are always for the session's account. `userName` MUST match the account name case-insensitively, otherwise → `400 invalid_username`; `displayName` is ignored. The challenge records the session's user (BR-CH-2).
- **BR-REGO-6** The user handle MUST NOT be derived from the name, email or any personal data (WebAuthn privacy requirement).
- **BR-REGO-7** Response `200` — `PublicKeyCredentialCreationOptionsJSON`:

| Field | Value |
|---|---|
| `rp` | `{ "id": PASSKEY_RP_ID, "name": PASSKEY_RP_NAME }` |
| `user` | `{ "id": <handle>, "name": <userName>, "displayName": <displayName> }` |
| `challenge` | New challenge (§5) |
| `pubKeyCredParams` | MUST include ES256 (`-7`) and RS256 (`-257`); MAY list EdDSA (`-8`) first |
| `timeout` | `300000` |
| `excludeCredentials` | Every credential of this user as `{ "type": "public-key", "id", "transports" }`; `[]` for a new user. An authenticator that already holds one then fails with `InvalidStateError` instead of creating a duplicate |
| `authenticatorSelection` | `{ "residentKey": "required", "requireResidentKey": true, "userVerification": "preferred" }` — no `authenticatorAttachment`, so phones and security keys stay possible (FR-OPT-3) |
| `attestation` | `"none"` |
| `extensions` | MAY be `{ "credProps": true }`; nothing may depend on it, because the frontend's fallback parser drops extensions |
| `hints` | Omitted |

- **BR-REGO-8** Issues the challenge and sets the flow cookie (§5, §6.2).

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
- **BR-REGV-3** If the challenge was issued to a signed-in user, the request MUST still carry that user's session. Otherwise → `401 not_signed_in`.
- **BR-REGV-4** Verification follows §7.1.
- **BR-REGV-5** A credential ID that is already stored (for any user) → `400 verification_failed`.
- **BR-REGV-6** In one transaction: insert the user if new (a unique-name conflict from a concurrent registration → `409 username_taken`), insert the credential (§8) with its transports (FR-ENC-4), and create a session (§6), replacing any session the request carried.
- **BR-REGV-7** Response `200 { "user": User }` plus the session cookie.

### 4.3 `POST /authentication/options`
Request: `{}`. The body is ignored but MUST still be JSON (BR-GEN-2). No session needed.

- **BR-AUTHO-1** Response `200` — `PublicKeyCredentialRequestOptionsJSON`: `challenge` (§5), `rpId`, `allowCredentials: []`, `userVerification: "preferred"`, `timeout: 300000`. The empty `allowCredentials` makes any discoverable passkey for this RP eligible, which both the sign-in button and autofill (FR-COND-2) need.
- **BR-AUTHO-2** The response never depends on user input, so it reveals nothing about which accounts exist.
- **BR-AUTHO-3** The frontend calls this on page load, when the username field gets focus and after every ceremony (conditional UI), and abandons most of these challenges when it aborts the request. §5 keeps this cheap and bounded.

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
- **BR-SES-1** Always `200`: `{ "user": User }` for a live session, otherwise `{ "user": null }`. Never `401` — the frontend calls this on every page load and would show an error.
- **BR-SES-2** An unknown or expired session cookie is cleared in the response.
- **BR-SES-3** MAY extend the session (sliding expiry, BR-COOK-5).

### 4.6 `DELETE /session`
- **BR-SES-4** Deletes the session row and clears the cookie. Idempotent: `204` whether or not a session existed.
- **BR-SES-5** MUST answer `204 No Content` without a body. The frontend treats a `200` without a JSON body as an invalid response.

### 4.7 `DELETE /account`
- **BR-ACC-1** Requires a live session, otherwise → `401 not_signed_in`.
- **BR-ACC-2** In one transaction, deletes the user's credentials, all their sessions (every device), their pending challenges and the user row; clears the cookie; answers `204 No Content`.
- **BR-ACC-3** The username becomes available again.
- **BR-ACC-4** The frontend then calls `signalAllAcceptedCredentials` with the deleted user's handle and an empty list, so password managers drop the passkeys.

---

## 5. Challenges (FR-SEC-3)

- **BR-CH-1** 32 bytes from a cryptographically secure generator, encoded base64url.
- **BR-CH-2** Stored server-side with: type (`registration` / `authentication`), flow ID, pending user (handle, name, display name — registration only), session user (when adding a passkey), created and expiry times.
- **BR-CH-3** Bound to the browser: the options endpoints set a flow cookie (§6.2) if it is missing, and a challenge can only be redeemed by a request carrying the same flow ID. A challenge obtained in one browser is useless in another.
- **BR-CH-4** A challenge lives for the ceremony timeout (300 s) plus 30 s for the verify request.
- **BR-CH-5** Single use: redeeming deletes the row atomically (e.g. `DELETE … RETURNING`) **before** any cryptographic verification, so a replayed or failing response can never use it again.
- **BR-CH-6** Redeem outcomes: not found, already used, other flow or wrong type → `400 verification_failed`; found but expired → `400 challenge_expired`.
- **BR-CH-7** Several outstanding challenges per flow are allowed (the autofill request and a button-triggered ceremony overlap briefly). At most 5 are kept per flow; issuing a sixth drops the oldest.
- **BR-CH-8** Expired rows are removed periodically (BR-OPS-2).
- **BR-CH-9** Challenge values are never logged.

---

## 6. Sessions and Cookies (FR-AUTH-5, FR-SEC-5)

### 6.1 Session cookie
- **BR-COOK-1** Name `__Host-session` in production. Over `http://localhost` in development the name is `session` without `Secure`, because not every browser accepts `Secure` cookies on plain http.
- **BR-COOK-2** Attributes: `HttpOnly`, `Secure` (production), `SameSite=Lax`, `Path=/`, `Max-Age` = the session TTL. No `Domain`.
- **BR-COOK-3** Value: 32 random bytes, base64url. The database stores only the SHA-256 of the token, so a database leak does not expose usable sessions.
- **BR-COOK-4** Rotation: every successful registration or authentication creates a new session and deletes the one the request carried (prevents session fixation).
- **BR-COOK-5** Lifetime `SESSION_TTL_DAYS` (default 30). Sliding: when less than half remains, the expiry is extended and the cookie re-sent.
- **BR-COOK-6** `hooks.server.ts` resolves the cookie on every request into `event.locals.user` (or `null`), deleting expired rows it meets. Endpoints read the user only from `locals`.
- **BR-COOK-7** Sessions record created, expiry and last-seen times (last-seen updated at most once per hour) and MAY record the user agent for a future "signed-in devices" list.
- **BR-COOK-8** Tokens never appear in response bodies, URLs or logs. The frontend stores no secret anywhere.

### 6.2 Flow cookie
- **BR-COOK-9** Name `__Host-passkey-flow` (development: `passkey-flow`, no `Secure`); `HttpOnly`, `SameSite=Strict`, `Path=/`; value 16 random bytes, base64url; `Max-Age` = challenge lifetime, refreshed whenever options are issued. It only links challenges to a browser and grants no access by itself.

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
- **BR-WA-15** Sign counter: if the stored or the received counter is non-zero, the received one MUST be greater, otherwise → `verification_failed` and a `counter_regression` security log entry (possible cloned authenticator). `0`/`0` — typical for synced passkeys — is fine.
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

All times are Unix milliseconds (UTC). Foreign keys cascade on delete.

| Table | Column | Type | Notes |
|---|---|---|---|
| `users` | `id` | TEXT PK | User handle, base64url (BR-GEN-5) |
| | `name` | TEXT | As first entered |
| | `name_key` | TEXT UNIQUE | Lower-cased NFC form for uniqueness (BR-REGO-2) |
| | `display_name` | TEXT | |
| | `created_at` | INTEGER | |
| `credentials` | `id` | TEXT PK | Credential ID, base64url |
| | `user_id` | TEXT FK → `users.id` | Indexed |
| | `public_key` | BLOB | COSE key as returned by verification |
| | `algorithm` | INTEGER | COSE algorithm ID |
| | `counter` | INTEGER | Sign counter |
| | `transports` | TEXT | JSON array (FR-ENC-4) |
| | `aaguid` | TEXT | Authenticator model, for naming passkeys later |
| | `backup_eligible` | INTEGER | 0/1 |
| | `backed_up` | INTEGER | 0/1 |
| | `name` | TEXT | Default "Passkey"; editable later (§13) |
| | `created_at` | INTEGER | |
| | `last_used_at` | INTEGER NULL | |
| `sessions` | `token_hash` | TEXT PK | SHA-256 of the cookie token |
| | `user_id` | TEXT FK → `users.id` | Indexed |
| | `created_at`, `expires_at`, `last_seen_at` | INTEGER | `expires_at` indexed |
| | `user_agent` | TEXT NULL | Optional |
| `challenges` | `challenge` | TEXT PK | base64url |
| | `flow_id` | TEXT | Indexed |
| | `type` | TEXT | `registration` / `authentication` |
| | `user_handle`, `user_name`, `user_display_name` | TEXT NULL | Pending user (registration) |
| | `session_user_id` | TEXT NULL | Set when adding a passkey |
| | `created_at`, `expires_at` | INTEGER | `expires_at` indexed |

- **BR-DATA-1** SQLite runs with `foreign_keys=ON` and `journal_mode=WAL`.
- **BR-DATA-2** Schema changes are numbered SQL migrations applied in order at startup and tracked (e.g. `PRAGMA user_version`).
- **BR-DATA-3** The database file lives outside the build output (`data/`, gitignored).
- **BR-DATA-4** Every multi-row write is a single transaction; unique-constraint violations are mapped to the error codes in §4, never surfaced as `500`.

---

## 9. Security

- **BR-SEC-1** Production is HTTPS only (TLS at the proxy) with HSTS. Development uses `localhost` only (FR-SEC-1).
- **BR-SEC-2** Every POST and DELETE MUST carry an `Origin` header equal to one of `PASSKEY_ORIGIN`, otherwise → `403 forbidden_origin`. Browsers send `Origin` on all non-GET fetches, including same-origin ones.
- **BR-SEC-3** CSRF (FR-SEC-6): state changes need JSON POST or DELETE, which a cross-site page cannot send without a CORS preflight; the backend answers no preflight, `SameSite` cookies are not sent cross-site, and BR-SEC-2 checks the origin anyway. SvelteKit's built-in origin check still covers form posts.
- **BR-SEC-4** No CORS headers while the API is same-origin. If the API is ever split off: an exact origin allow-list, `Access-Control-Allow-Credentials: true`, methods `GET, POST, DELETE`, header `Content-Type` — never `*`.
- **BR-SEC-5** Rate limits per client IP (in memory, fine for one process): options endpoints 30/min, verify endpoints 10/min, registration options for one username 5/min. Excess → `429 rate_limited` with `Retry-After`. Behind a proxy the IP comes from `ADDRESS_HEADER` (§10).
- **BR-SEC-6** Account enumeration: only `/registration/options` reveals whether a name exists (inherent to FR-ERR-2) and it is rate-limited; `/authentication/options` is never user-specific.
- **BR-SEC-7** The server never sees private keys (FR-SEC-4); session tokens are stored only as hashes; no secret is ever returned in a body.
- **BR-SEC-8** Security events are logged as structured JSON with request ID, user handle, credential ID, IP and user agent: registration, sign-in success and failure (with the failed check), `counter_regression`, `unknown_credential`, sign-out, account deletion, rate limiting. Cookies, tokens, challenges and full credential payloads are never logged.
- **BR-SEC-9** Strict schema validation and size limits (BR-GEN-2) run before any lookup or crypto.
- **BR-SEC-10** `@simplewebauthn/server` is pinned to a major version and updated for security releases.

---

## 10. Operations

- **BR-OPS-1** Startup order: validate configuration, open the database, run migrations, then accept requests. Any failure stops the process.
- **BR-OPS-2** Expired challenges and sessions are deleted at startup and every 10 minutes.
- **BR-OPS-3** The SQLite file is backed up with the online backup API or `VACUUM INTO`, never by copying the live file. Losing it orphans every passkey.
- **BR-OPS-4** Behind a reverse proxy, adapter-node's `ORIGIN` (or `PROTOCOL_HEADER` + `HOST_HEADER`) and `ADDRESS_HEADER` are set, so origin checks and rate limits see real values.
- **BR-OPS-5** One server process is assumed (SQLite, in-memory rate limits). Scaling out needs a shared rate-limit store and a server database — out of scope.
- **BR-OPS-6** The service worker only caches page navigations, so `/api/*` responses are never served from a cache. This MUST stay true.
- **BR-OPS-7** MAY expose `GET /api/health` returning `200 { "ok": true, "passkeyBackend": "on" | "off" }` after a trivial database query.

---

## 11. Frontend Integration Checklist

What the merged frontend relies on; each item is also a requirement above.

- `PUBLIC_PASSKEY_API_URL=/api/passkey` is set at runtime (no rebuild needed).
- Requests use `credentials: "include"` and `cache: "no-store"`; POSTs send JSON; GET and DELETE send no body.
- Verify endpoints and `GET /session` wrap the user as `{ "user": … }`; `GET /session` is always `200` (BR-SES-1).
- DELETE endpoints answer exactly `204` (BR-SES-5).
- Errors are `{ code, message }`; unknown codes show a generic message (BR-ERR-2).
- `user.id` is the WebAuthn user handle (BR-GEN-5); `unknown_credential` triggers the Signal API (BR-ERR-3).
- "Add a passkey" sends `{ "userName": <account name> }` while signed in (BR-REGO-5).
- Authentication options are requested often and abandoned often (BR-AUTHO-3, BR-CH-7).
- `PUBLIC_PASSKEY_RP_ID` is only needed when the RP ID is not the page's hostname.

---

## 12. Frontend Follow-ups (not required for go-live)

- Map `rate_limited`, `invalid_request` and `forbidden_origin` to specific messages, and give `invalid_username` a text that also fits "too long".
- Restart the autofill request shortly before its challenge expires; today a user who returns to an old tab gets "The request expired" once.
- Render the signed-in state during SSR from `locals.user` (see `passkey-ssr-implementation.md`) instead of after hydration.
- Passkey management UI once the §13 endpoints exist.

---

## 13. Future Extensions (not part of this contract yet)

- **Passkey management (FR-OPT-1):** `GET /credentials` → `{ "credentials": [{ "id", "name", "createdAt", "lastUsedAt", "backedUp", "transports" }] }`; `PATCH /credentials/:id` `{ "name" }`; `DELETE /credentials/:id`, refusing the last passkey with `409 last_credential`. After a change the frontend calls `signalAllAcceptedCredentials` with the remaining IDs.
- **Step-up for destructive actions:** `DELETE /account` requires a sign-in within the last 5 minutes, otherwise `403 reauthentication_required`.
- **Account recovery / fallback sign-in (FR-OPT-5):** e.g. an email magic link. Without it, a user who loses every passkey loses the account.
- **Related origins:** `/.well-known/webauthn` if the site ever runs on several domains.
- **Local-mode accounts are not migrated.** A backend must not trust public keys reported by the browser without a registration ceremony; users register again, and the old local passkeys can be cleaned up with the Signal API.

---

## 14. Testing

- **BR-TEST-1** Unit tests (Vitest) cover: username and display-name validation; challenge issue, redeem, expiry, single use, flow binding and the per-flow cap; session hashing, rotation, sliding expiry and expiry cleanup; error-to-status mapping; counter logic; the user-handle check.
- **BR-TEST-2** End-to-end tests (Playwright with a Chrome DevTools Protocol virtual authenticator, FR-TEST-3) run against `pnpm build && node build` with a temporary database and `PUBLIC_PASSKEY_API_URL=/api/passkey`, and cover every flow in FR-TEST-4:
  - register, reload (still signed in), sign out, sign in with the button;
  - repeat registration on the same device while signed in → `InvalidStateError` message, no duplicate stored;
  - taken username → message before any prompt, authenticator untouched;
  - sign in when the authenticator has no passkey → neutral message;
  - credential deleted from the database → `404 unknown_credential`, and the virtual authenticator loses the passkey through the Signal API;
  - autofill: request started on load, aborted silently by other ceremonies;
  - delete account → user, credentials and every session gone; the old cookie no longer works.
- **BR-TEST-3** Negative security tests: replayed assertion; challenge from another flow cookie; expired challenge (fake clock) → `challenge_expired`; tampered signature; `userHandle` of another user; counter regression; wrong `Origin` → `403`; `text/plain` POST → `415`; oversized body → `413`; rate limit → `429`; a signed-out session token is rejected server-side; cookie attributes asserted.
- **BR-TEST-4** Manual checks: Chrome, Safari and Firefox; a platform authenticator and a security key; the real deployed domain (FR-TEST-1, -2, -5).

---

## 15. Traceability

| Frontend requirement | Covered by |
|---|---|
| FR-REG-2 fresh registration options | BR-REGO-1…8, §5 |
| FR-REG-4 verify and store credential | BR-REGV-1…7, §7.1, §8 |
| FR-AUTH-2 fresh authentication options | BR-AUTHO-1…3, §5 |
| FR-AUTH-4/5 verify assertion, session | BR-AUTHV-1…7, §6 |
| FR-COND-2/3 autofill | BR-AUTHO-1 (empty `allowCredentials`), BR-AUTHO-3, BR-CH-7 |
| FR-ENC-1 base64url | BR-GEN-4 |
| FR-ENC-4 transports | BR-REGV-1, BR-REGO-7 (`excludeCredentials`), `credentials.transports` |
| FR-ERR-2 username taken before `create()` | BR-REGO-4 |
| FR-SEC-1 secure context | BR-SEC-1, BR-CONF-4 |
| FR-SEC-2 RP ID per environment | BR-CONF-2, BR-CONF-3 |
| FR-SEC-3 server challenges | BR-CH-1…9 |
| FR-SEC-4 no private keys | BR-SEC-7 |
| FR-SEC-5 httpOnly session cookie | BR-COOK-1…8 |
| FR-SEC-6 CSRF | BR-SEC-2, BR-SEC-3 |
| FR-API-1…4 endpoints | §4 |
| FR-API-5 error shape | BR-ERR-1…5 |
| FR-OPT-1 passkey management | §13 (future) |
| FR-OPT-2 add a passkey | BR-REGO-5, BR-REGV-3 |
| FR-OPT-3 cross-device | BR-REGO-7 (no `authenticatorAttachment`) |
| FR-OPT-4 Signal API | BR-ERR-3, BR-GEN-5, BR-ACC-4 |
| FR-TEST-1…5 | §14 |

---

## 16. Definition of Done

- All seven endpoints behave as in §4, with §5–§9 enforced.
- The merged frontend works in backend mode with no frontend code change.
- BR-TEST-1…3 pass locally; BR-TEST-4 has been done once on the deployed domain.
- `pnpm check`, `pnpm lint` and `pnpm build` are clean.
- The README's backend contract, `.env.example` and this document agree; any divergence is fixed in all three.
