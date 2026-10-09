# auth/

Admin auth (local argon2id users, TOTP, OIDC, sessions, CSRF, lockout) and MCP endpoint auth
(`external` / `bearer` / `oauth` / `bearer+oauth`, built-in OAuth 2.1 authorization server). Every
credential resolves to an enabled owner whose role must have the endpoint; roles and self-registration
are in `roles.ts` and `users.ts`, and the Admin API is admin-only outside `/api/profile` and `/api/me`.

Design: [`docs/design/06-authentication.md`](../../../../docs/design/06-authentication.md) §6 (roles §6.4, self-registration §6.5).
