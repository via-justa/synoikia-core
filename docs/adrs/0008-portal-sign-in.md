---
status: accepted
date: 2026-10-14
---

# Portal sign-in

## Context and Problem Statement

The admin portal changes every security setting: access levels, credentials, roles and plugins. The approval page and the OAuth sign-in on the MCP listener use the same user accounts. How do users sign in, and what protects their sessions?

## Decision Drivers

- An install must work without an external identity provider.
- An admin who uses single sign-on must not lock everyone out.
- A guessed password or code must not give access, and a stolen cookie must be of little use.

## Considered Options

- Local users with argon2id passwords and optional TOTP, optional OIDC, server-side sessions, CSRF tokens and a lock after failed sign-ins.
- OIDC only.
- A trusted identity header from a reverse proxy.

## Decision Outcome

Chosen option: "Local users with optional TOTP and OIDC". An install works on its own, and single sign-on stays optional.

**Local users.** Core stores users in the `users` table. A local account has an argon2id password hash (`m=64 MiB, t=3, p=1`), and an SSO account has none (ADR-0025). Each user has one role (ADR-0010).

**First user.**

- If there are no users, the portal shows a Setup page. The setup endpoint works only while the users table is empty. The first user gets the Admin role.
- For an install without a browser, `ADMIN_BOOTSTRAP_USERNAME` and `ADMIN_BOOTSTRAP_PASSWORD` create the first user at start if the table is empty. After that, core ignores them and logs a warning.

**TOTP (optional, for each user).**

- RFC 6238. The user enrolls on the Profile page with a QR code. Core encrypts the secret with the master key.
- Core makes ten single-use recovery codes and stores them as hashes. The profile shows how many are left.
- The user can replace all recovery codes (`POST /api/profile/totp/recovery-codes`). This needs a current code from the app, with the replay guard of the code step.
- Core refuses a recovery code there. A wrong code gives `401 invalid_code`, and without TOTP core answers `409 totp_disabled`. Core audits `totp_recovery_rotated`.
- With `security.requireTotp`, each local account must enroll at the next sign-in. An SSO account has no TOTP (ADR-0025).

**OIDC (optional).** The admin configures it on Settings → User auth.

- Issuer URL (discovery), client id, client secret (encrypted) and scopes. Core checks the issuer URL and the client id only while OIDC is on.
- An allow policy: e-mail addresses, `sub` values and a required group claim value. An e-mail address counts only if the ID token has `email_verified: true`.
- An e-mail entry is an exact address or `*@domain`, compared without case. `*@domain` accepts that domain after the last `@`, but not its subdomains. Core refuses other wildcard forms.
- The flow is the authorization code flow with PKCE, `state` and `nonce`.
- An identity signs in only to its SSO account (ADR-0025). `autoProvision` is off by default. Then the admin makes the SSO account first. With `autoProvision` and self-registration on (ADR-0010), core creates an SSO account for each accepted identity.
- After an OIDC sign-in, core returns only to a path of the portal. The path starts with one `/` and holds no `\`, no space and no control character. Core returns to `/` for any other path.
- An automatic user gets the name from the identity. Core compares names without case. When the name is taken, core adds `-2`, `-3` and so on.

**Local sign-in fallback.**

- Local password sign-in is always available, unless `security.disableLocalLogin` is true.
- The admin can set it only while OIDC is on and at least one enabled SSO account exists.
- While it is set, core refuses with 409 `local_login_disabled`: turning OIDC off, or disabling or deleting the last enabled SSO account.
- `ADMIN_FORCE_LOCAL_LOGIN=true` turns local sign-in on again.

**Sessions.**

- Core stores sessions on the server (`sessions` table). The id is a random 256-bit value. Core stores only its HMAC with a pepper from the master key.
- The cookie is `__Host-syn_admin`: `HttpOnly`, `SameSite=Strict`, `Path=/`, and `Secure` behind TLS.
- A session ends after 30 minutes without use, and after 12 hours in total. Both values are settings.
- Sign-out deletes the session. A password change ends the other sessions of the user.

**CSRF.** Each request that changes state on `/api/*` or `/auth/*` needs a double-submit token: the `syn_csrf` cookie and the `X-CSRF-Token` header. If `PUBLIC_ADMIN_URL` is set, core also checks `Origin` against it. Before that, any browser `Origin` must be a host name of the admin listener (ADR-0015).

**Brute-force protection.**

- Five failed sign-ins for a user name in 15 minutes lock that user name. The lock lasts 15 minutes from the fifth failure.
- Core counts failures for each surface. Failures on the MCP listener sign-in lock the user name there only, never in the admin portal.
- A budget of 60 attempts in 5 minutes applies to each client IP. It covers password sign-in, its code step and the sign-up form on both listeners, client registration and the connection test.
- Wrong codes and wrong current passwords on the Profile page count toward the lock of the admin portal. While the user name is locked, core answers `429 locked` there and checks nothing.
- Core audits sign-in failures and wrong codes as `auth` events, on both surfaces: `totp_failed` for a code, `password_failed` for a current password. On the Profile page, the detail names the route.

**Delete a user.** An admin deletes a user (`DELETE /api/users/:id`). The delete is permanent.

- Core refuses to delete the admin who asks, the last user or the last enabled admin. While local sign-in is off, it also keeps the last enabled SSO account.
- First, core takes every credential of the user away: sessions, OAuth grants and bearer tokens. It also ends their pending approvals and the session grants that they gave (ADR-0006).
- Then, in one transaction, core deletes the user, their personal levels and their own pre-approval rules. It keeps the shared rows that name the user and clears that name. It writes the audit event `user_deleted`.
- Core does not change the audit log. The log reads the user name of a deleted user from `user_deleted`.

### Consequences

- Good, because an install needs no identity provider, and an admin can still require TOTP or use single sign-on.
- Good, because the database holds no usable session id, password or recovery code.
- Bad, because a user name lock lets anyone lock out a user for 15 minutes. The lock is for each surface, so the MCP listener cannot lock the admin portal. Issue #114 tracks a progressive lock, one lock for each user and an admin unlock.

The model views `containers` and `coreComponents` show the admin listener. The feature files `@id:first-account`, `@id:portal-sign-in`, `@id:portal-sessions`, `@id:single-sign-on`, `@id:local-sign-in-off`, `@id:users` and `@id:user-deletion` specify its behavior.
