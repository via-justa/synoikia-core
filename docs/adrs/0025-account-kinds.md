---
status: accepted
date: 2026-10-24
---

# An account is local or SSO for life

## Context and Problem Statement

A portal user could have a password, an OIDC identity, or both, and could link or unlink the identity in the profile. A stolen session of a user without a password could add one and keep the account. It could also link another identity, or set up its own authenticator app to pass a check. How does core keep a stolen session from adding a way in?

## Decision Drivers

- A session alone must never add a way to sign in to its account.
- An admin who uses single sign-on must still be able to make accounts before people sign in.
- An upgrade must keep each person able to sign in.

## Considered Options

- Two kinds of account, fixed when the account is made. Nobody links.
- One kind of account, with proof before a new password or link: a recent OIDC sign-in or a TOTP code.

## Decision Outcome

Chosen option: "Two kinds of account". Any proof that a session can make for itself proves nothing, and the second option had several such paths.

- `users.kind` is `local` or `sso`. Core sets it when it makes the account and never changes it.
- **Local.** The account signs in with its password, and with TOTP when it has an app. It never signs in with OIDC. Core stores no OIDC identity on it.
- **SSO.** The account signs in only with OIDC. It has no password, no TOTP app and no recovery codes. Core refuses a password or an app for it on every route, the Admin API included. `security.requireTotp` applies to local accounts only, because the identity provider owns the factors of an SSO account.
- **Making an SSO account.** The admin gives an e-mail address (`users.oidc_email`, unique, compared without case). The first OIDC sign-in with that address, verified by the provider, sets `oidc_issuer` and `oidc_subject` and clears `oidc_email`. After that, only the issuer and subject count. A changed address at the provider keeps the account.
- Automatic users (ADR-0010) are SSO accounts. The first account, the start-up admin and accounts from the sign-up form are local.
- An identity that no SSO account has does not sign in, even when a local account has the same address.
- An SSO account that waits for its address is no way in yet. While local sign-in is off, only an SSO account that signed in once counts as a way in.
- A proxy identity (ADR-0009) still names any account that the admin made, of either kind. The admin sets up the proxy and trusts it.
- **Upgrade.** A user whose identity still signs in becomes an SSO account: single sign-on is on, and the identity comes from the configured issuer. The migration removes the password, the TOTP app and the recovery codes of that user. When the identity cannot sign in and the user has a password, the migration removes the identity instead, and the user keeps the password. So the upgrade locks nobody out. Each change has an audit row.

### Consequences

- Good, because a stolen session cannot add a password, an app or an identity to its account.
- Good, because each sign-in path checks one kind, so a gap in one path cannot open the other.
- Bad, because a person who wants to change the way they sign in needs a new account. Their own levels, rules and tokens stay with the old one.
- Bad, because a user who signed in with a password and also had a working link loses the password on upgrade.

The model views `containers` and `coreComponents` show the auth component. The feature files `@id:single-sign-on`, `@id:portal-profile`, `@id:portal-users` and `@id:upgrades` specify its behavior.
