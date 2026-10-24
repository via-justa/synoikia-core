---
status: accepted
date: 2026-10-11
---

# MCP client authentication

## Context and Problem Statement

Each endpoint on the MCP listener reaches an upstream. MCP clients differ: some take a static token, some speak OAuth, and some sit behind an access proxy. How does a client prove who it is, and how much can a credential reach?

## Decision Drivers

- Each call must belong to an enabled user, whose role decides what the call reaches (ADR-0010).
- The admin must be able to turn off a method for all endpoints, or for one.
- A stranger must learn nothing about an endpoint before authentication.
- The person who connects a client must decide once how much the client can ever do.

## Considered Options

- Three methods (`bearer`, `oauth`, `external`), enabled globally and narrowed for each endpoint, with an access ceiling on each credential.
- OAuth only.
- No authentication on the MCP listener, with a reverse proxy in front.

## Decision Outcome

Chosen option: "Three methods, enabled globally and narrowed for each endpoint". Each client gets a method that it supports, and the admin decides which ones apply.

| Method     | Accepts                                                                | Recorded identity                            |
| ---------- | ---------------------------------------------------------------------- | -------------------------------------------- |
| `bearer`   | `Authorization: Bearer syn_…` tokens from the portal                   | Token name                                   |
| `oauth`    | OAuth 2.1 access tokens from the built-in authorization server         | OAuth client name and the user who consented |
| `external` | A request that the configured external provider identifies. See below. | `external:<identity>`                        |

The admin enables a set of methods (Settings → Client auth, `mcp.clientAuth`). By default, `bearer` and `oauth` are on and `external` is off.

**Methods of an endpoint.**

- An endpoint accepts all enabled methods, or a subset of them (`plugin_instances.auth_methods`). The effective methods are those that are also enabled globally.
- If the effective set is empty, core refuses each request. A caller with a live credential gets 403, and other callers get the answer of an unknown slug (401). The portal shows a warning.
- If core cannot read the stored methods, all methods are off. Core refuses a save that enables no method, with 400 `invalid_settings`.

**Method selection.**

1. A request with an `Authorization: Bearer` header uses `bearer` or `oauth`, if the endpoint allows the method. `oauth` also needs `PUBLIC_MCP_URL`.
2. A request without a bearer token uses `external`, if the endpoint allows it.
3. If `external` does not identify the caller and the endpoint also allows `bearer` or `oauth`, core sends the bearer challenge (401).

**`external` method.**

- An external provider identifies the user of each request. The admin selects it (`mcp.external.provider`). Core refuses to enable `external` while the provider has no configuration.
- Each provider is one module in the provider harness (`auth/external.ts`). The MCP listener uses only the harness, never a provider directly.
- **Cloudflare Access** is the only provider. Its configuration is `mcp.cfAccess.teamDomain` and `mcp.cfAccess.aud`.
- The `Cf-Access-Jwt-Assertion` header must verify against the JWKS of the team, with `RS256`, the issuer and audience of the application, and `exp` and `iat`.
- The identity is the `email` claim. Core refuses an assertion without an e-mail address, and the assertion of a service token (an empty `sub`, or a `common_name` claim).
- **User.** Core finds the user whose user name is the identity, without regard to case. Only a user that an admin made, or that `external` registered, can match.
- A user from the sign-up form or OIDC never matches, so nobody can take an external identity first.
- If there is no such user, self-registration (ADR-0010) creates one. If it is off, the name is taken, or the identity is not a valid user name, core refuses with 403.
- Core refuses a caller that the provider does not identify (401). The approval page also uses the provider, without self-registration (ADR-0006). Core reads no other identity header.

**Bearer tokens** (Clients & Tokens page).

- Format `syn_<base62 of 32 bytes>`. Core shows a token once and stores its SHA-256.
- Fields: name, owner, scope (a list of instance ids, or `*`), access ceiling, optional expiry and `last_used_at`.
- Each user makes and revokes their own tokens on the Profile page. A user who is not an admin can scope a token only to the endpoints of their role.
- `*` means all endpoints of the role at the time of each call. The admin can revoke any token.

**Built-in OAuth 2.1 authorization server.** It follows the MCP authorization specification.

- **Protected-resource metadata** (RFC 9728) is at `/.well-known/oauth-protected-resource/{slug}`. It names `PUBLIC_MCP_URL` as the authorization server and has no `resource_name`.
- It exists only for an endpoint whose effective methods include `oauth`. For other endpoints it returns 404.
- **Authorization-server metadata** (RFC 8414) is at `/.well-known/oauth-authorization-server`.
- **Dynamic client registration** (RFC 7591) is at `/oauth/register`. The admin can turn it off (`oauth.allowDynamicRegistration`), and then registers clients on the Clients & Tokens page.
- **`/oauth/authorize`** uses the authorization code flow with PKCE `S256`. The `resource` parameter (RFC 8707) must give one or more endpoint URLs.
- The user signs in on the MCP listener page with a password and TOTP, or with OIDC. With `security.requireTotp`, core refuses a local account without TOTP.
- The consent page shows the client name, the host of its redirect URI, and the requested endpoints of the user's role. The user can remove endpoints and selects the access ceiling.
- **`/oauth/token`.** Access tokens are opaque, stored as hashes, and valid for 1 hour by default. Their audience is the granted resources.
- Refresh tokens change at each use, with a sliding window of 30 days by default. If core sees a used refresh token again, it revokes the full token family.

**Order of checks.** Authentication comes before all other checks.

- A request to `/{slug}` without credentials gets 401 with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/{slug}"` when the endpoint accepts `oauth`.
- A disabled endpoint answers a stranger like an enabled one. It returns 503 only after authentication.
- An unknown slug returns 401 with a plain `Bearer` challenge. It returns 404 only to a caller with a valid credential.

**Grants are bound to instances, not slugs.** Core records the instance that each consented URL named at consent time, and checks tokens against these ids.

- A renamed endpoint keeps its grants. A new endpoint that takes an old slug does not get the old grants.
- When an endpoint is deleted, core revokes the grants that cover nothing else.

**Revocation.**

- The Clients & Tokens page lists the grants of each user and client, and the admin can revoke them.
- A password change or a disabled user revokes all grants of the user, and their tokens. A disabled user also loses their bearer tokens and the session grants that they gave.
- `refresh` refuses a disabled user. A deleted user loses all grants and tokens (ADR-0008). When the admin enables a user again, no grant or token comes back.

**Scope check.** For each request to `/{slug}`, the scope or audience of the credential must include that instance. A credential outside its scope gets 403, not 401.

**Owner check.** Each credential has an owner: the user who made the token, who gave the OAuth consent, or whom `external` found. The owner must be enabled and their role must have the instance. Otherwise core refuses with 403.

**Access ceiling.** Each credential has an access ceiling: `read` or `write`.

- On the OAuth consent page, the user selects "Read only" (the default) or "Read & write". The grant stores the ceiling, and all its tokens have it. A wider ceiling needs a new consent.
- A bearer token has the same field, `read` by default.
- A principal with ceiling `read` never reaches a write, whatever the access levels are (ADR-0004).
- The `external` method trusts the external provider. Core does not limit its principals.

### Consequences

- Good, because each call belongs to an enabled user, and the role of that user limits it.
- Good, because a stranger cannot tell an unknown slug from a disabled endpoint.
- Good, because a client that a person connected with "Read only" never writes.
- Bad, because the `external` method trusts the access policy of the provider. ADR-0002 lists this risk.

The model views `containers` and `oauth` show the MCP listener and the OAuth flow. The feature files `@id:client-auth-methods`, `@id:bearer-tokens`, `@id:access-gateway`, `@id:oauth-discovery`, `@id:oauth-clients`, `@id:oauth-consent` and `@id:oauth-tokens` specify its behavior.
