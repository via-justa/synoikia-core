# §6 Authentication

## 6.1 Admin portal sign-in

The Admin listener (port 8081) has its own sign-in.

**Local users.** Core stores users in the `users` table with an argon2id password hash (`m=64 MiB, t=3, p=1`). Each user has one role (§6.4).

**First user.**

- If there are no users, the portal shows a Setup page to create the first user. The setup endpoint works only while the users table is empty. The first user gets the Admin role.
- For an install without a browser, `ADMIN_BOOTSTRAP_USERNAME` and `ADMIN_BOOTSTRAP_PASSWORD` create the first user at start if the table is empty. After that, core ignores them and logs a warning if they are still set.

**TOTP (optional, for each user).**

- RFC 6238. The user enrolls on the Profile page with a QR code.
- Core encrypts the secret with the master key.
- Core makes ten single-use recovery codes and stores them as hashes.
- With `security.requireTotp`, each user must enroll at the next sign-in.

**OIDC (optional).** The admin configures it on Settings → Authentication:

- issuer URL (discovery), client id, client secret (encrypted), scopes;
- an allow policy: allowed e-mail addresses, allowed `sub` values, and a required group claim value. An e-mail address counts only if the ID token has `email_verified: true`. A missing claim means "not verified".
- The flow is the authorization code flow with PKCE, `state` and `nonce`.
- `autoProvision` is off by default. Then an OIDC identity must be linked to a local user first (Profile → "Link OIDC identity"). If it is on and self-registration is on (§6.5), core creates a user for each identity that the allow policy accepts.

**Local sign-in fallback.**

- Local password sign-in is always available, unless `security.disableLocalLogin` is true.
- The admin can set that only while OIDC is on and at least one enabled user is linked to it.
- While it is set, core refuses these actions with 409 `local_login_disabled`: turn OIDC off, unlink, or disable the last enabled linked user.
- `ADMIN_FORCE_LOCAL_LOGIN=true` turns local sign-in on again.

**Sessions.**

- Core stores sessions on the server (`sessions` table). The id is a random 256-bit value. Core stores only its HMAC with a pepper from the master key.
- The cookie is `__Host-syn_admin`: `HttpOnly`, `SameSite=Strict`, `Path=/`, and `Secure` behind TLS.
- A session ends after 30 minutes without use, and after 12 hours in total. Both values are settings.
- Sign-out deletes the session. A password change ends the other sessions of the user.

**CSRF.** Each request that changes state on `/api/*` or `/auth/*` needs a double-submit token: the `syn_csrf` cookie and the `X-CSRF-Token` header. If `PUBLIC_ADMIN_URL` is set, core also checks `Origin` against it.

**Brute-force protection.**

- Five failed sign-ins for a user name in 15 minutes lock that user name for 15 minutes.
- Core counts failures for each surface. Failures on the MCP listener sign-in lock the user name there only, never in the admin portal.
- A per-IP budget applies to `/auth/*` and to `/api/instances/:id/connection/test`.
- Core audits sign-in failures as `auth` events.

## 6.2 MCP endpoint authentication

The authentication mode is a global default (Settings → MCP Access). Each instance can override it (Instance → Settings).

| Mode           | Accepts                                                        | Recorded identity                                                |
| -------------- | -------------------------------------------------------------- | ---------------------------------------------------------------- |
| `external`     | All requests. The reverse proxy authenticates. See below.      | JWT e-mail, header value, or `external (anonymous, <client IP>)` |
| `bearer`       | `Authorization: Bearer syn_…` tokens from the portal           | Token name                                                       |
| `oauth`        | OAuth 2.1 access tokens from the built-in authorization server | OAuth client name and the user who consented                     |
| `bearer+oauth` | Both                                                           | As above                                                         |

**`external` mode.**

- **Cloudflare Access.** If the admin sets `teamDomain` and `aud`, the `Cf-Access-Jwt-Assertion` header must verify against the JWKS of the team. A service token records `service:<client id>`. Core refuses an assertion that names nobody.
- **Trusted identity header.** An optional header, for example `Remote-User` from Authelia, gives the identity.
- **User.** Core finds the user whose user name is the identity. Upper and lower case do not matter. Only a user that an admin made, or that `external` mode registered, can match. A user from the sign-up form or OIDC never matches, so nobody can take a proxy identity first. If there is no such user, self-registration (§6.5) creates one. If self-registration is off, the name is taken, or the identity is not a valid user name, core refuses the request with 403.
- Core refuses a caller that the proxy does not name (401). Each call belongs to a user.
- The portal shows a warning for `external` without JWT verification. Port 8080 must then be reachable only through the proxy.

**Bearer tokens** (Clients & Tokens page):

- Format `syn_<base62 of 32 bytes>`. Core shows a token once and stores its SHA-256.
- Fields: name, owner (the user who made it), scope (a list of instance ids, or `*`), access ceiling (`read` by default, or `write`, §6.3), optional expiry, `last_used_at`.
- Each user makes and revokes their own tokens on the Profile page. A user who is not an admin can scope a token only to the endpoints of their role. `*` means all endpoints of the role at the time of each call.
- The admin can revoke a token.
- A token used on an endpoint outside its scope gets 403, not 401.

**Built-in OAuth 2.1 authorization server.** It follows the MCP authorization specification.

- **Protected-resource metadata** (RFC 9728) is at `/.well-known/oauth-protected-resource/{slug}`. It names `PUBLIC_MCP_URL` as the authorization server and has no `resource_name`.
- **Order of checks.** A request to `/{slug}` without credentials gets 401 with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/{slug}"`. Authentication comes before all other checks:
  - A disabled endpoint answers a stranger like an enabled one. It returns 503 only after authentication.
  - An unknown slug returns 401 with a plain `Bearer` challenge. It returns 404 only to a caller with a valid credential.
- **Authorization-server metadata** (RFC 8414) is at `/.well-known/oauth-authorization-server`.
- **Dynamic client registration** (RFC 7591) is at `/oauth/register`. The admin can turn it off (`oauth.allowDynamicRegistration`). Then the admin registers clients on the Clients & Tokens page. The page lists all clients with their redirect URIs, and the admin can revoke them.
- **`/oauth/authorize`.**
  1. The flow is the authorization code flow. PKCE `S256` is required.
  2. The `resource` parameter (RFC 8707) must give one or more endpoint URLs.
  3. The user signs in on the MCP listener page: local password and TOTP, or OIDC. With `security.requireTotp`, core refuses a user without TOTP.
  4. The consent page shows the client name, the host of its redirect URI, and the requested endpoints.
  5. The user can remove endpoints from the list. They select the access ceiling (§6.3).
- **`/oauth/token`.**
  - Access tokens are opaque and valid for 1 hour by default. Core stores them as hashes. Their audience is the granted resources.
  - Refresh tokens change at each use, with a sliding window of 30 days by default. If core sees a used refresh token again, it revokes the full token family.
- **Grants are bound to instances, not slugs.** Core records the instance that each consented URL named at consent time. It checks tokens against these instance ids.
  - A renamed endpoint keeps its grants.
  - A new endpoint that takes an old slug does not get the old grants.
  - When an endpoint is deleted, core revokes grants that cover nothing else.
- **Revocation.**
  - The Clients & Tokens page lists the grants of each user and client. The admin can revoke them.
  - A password change or a disabled user revokes all grants of the user, and their tokens.
  - A disabled user also loses the bearer tokens that they made. `refresh` refuses a disabled user.
  - When the admin enables a user again, no grant or token comes back.

**Scope check.** For each request to `/{slug}`, core checks that the scope or audience of the credential includes that instance. This applies to both token kinds.

**Owner check.** Each credential has an owner: the user who made the token, the user who gave the OAuth consent, or the user that `external` mode finds. For each request, the owner must be enabled and the role of the owner must have the instance. Otherwise core refuses the request with 403. The consent page shows only the endpoints of the role of the user.

## 6.3 Access ceiling

Each credential has an access ceiling: `read` or `write`.

- On the OAuth consent page, the user selects "Read only" (the default) or "Read & write". The ceiling is stored on the grant. All access and refresh tokens of the grant have it. A wider ceiling needs a new consent.
- A bearer token has the same field, `read` by default.
- A principal with ceiling `read` never reaches a write, whatever the access levels are (§5.2.1).
- `external` mode trusts the proxy. Core does not limit its principals.

The person who connects a client decides once what the client can ever do.

## 6.4 Roles

Each user has one role. A role decides what the user can reach and change.

**Admin role.** It is built in, and nobody can change or delete it. An admin does all administration. Its access levels are the levels of each endpoint (§5.2.1). Core refuses a change that leaves no enabled admin (409 `last_admin`).

**Other roles.** An admin makes them on the Roles page. Each role has:

| Part                   | Meaning                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| Endpoints              | The endpoints that the role has. Other endpoints are not visible to its users. Their credentials get 403. |
| Role maximums          | For each group, and for an operation if necessary, the highest level. Not set means `none`. See §5.2.1.   |
| Set personal levels    | Users set a personal level for each group or operation, at most the role maximum.                         |
| Own pre-approval rules | Users add pre-approval rules that apply only to their own calls (§5.2).                                   |
| See endpoint status    | Users see the state, plugin, upstream version and last sync of their endpoints.                           |

**What each user gets.**

- Their profile, their own bearer tokens and their own OAuth grants.
- A read-only list of the endpoints of their role, the operations that they can call, and the level in force for each.
- The parts that the switches of their role allow.
- An approval page for their own calls only (§5.3).

**Rules.**

- A new endpoint, and a new group from a sync, start at `none` for each role.
- A change to a role or to a role maximum applies to the next call. It also applies to a parked execution before it continues.
- When an admin removes an endpoint from a role, core deletes the role maximums for that endpoint.
- Core refuses to delete a role that a user has (409 `role_in_use`), or that is the default role (409 `default_role`).
- If an admin turns off "Set personal levels", core ignores the personal levels and keeps them. It does the same for own rules.

## 6.5 Self-registration

Self-registration is off by default. It is on while an admin sets a default role (Settings → Admin UI settings). The default role can be any role, also Admin. The portal then asks for a typed confirmation.

A user that self-registration makes gets the default role. Core records the source in `registered_via` and audits it as `user_registered`. User names are unique without regard to case. A name from the sign-up form or OIDC cannot contain `:`. The sign-up form gives one error for a taken name, and does not tell that the name exists.

| Source     | When                                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `oidc`     | OIDC `autoProvision` is on and the allow policy accepts the identity.                                                               |
| `external` | An `external` endpoint gets an identity with no user (§6.2).                                                                        |
| `signup`   | The "Create account" form on the sign-in page. It needs `localSignup` and local sign-in on. The per-IP budget of `/auth/*` applies. |
