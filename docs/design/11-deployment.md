# §11 Deployment

## Image

- One image, built in stages:
  1. `pnpm install --frozen-lockfile`
  2. Build the SDK, then core, then the admin UI.
  3. The runtime stage is `node:22-bookworm-slim` with the production `node_modules` (native: `better-sqlite3`, `isolated-vm`, `argon2`), `packages/core/dist` and the admin UI `dist`.
- The image has no plugins. Core installs plugins into the data volume.
- The image is `ghcr.io/via-justa/synoikia`, for `linux/amd64` and `linux/arm64`. Its tag is the `version` of the root `package.json`. This version is separate from the package versions. `latest` is the newest stable release.
- `.github/workflows/release.yml` builds and pushes the image when a version change merges to `main`. Prereleases are published by hand only.
- The container runs as a user that is not root. `DATA_DIR=/data` is a volume. Ports 8080 and 8081 are exposed. `HEALTHCHECK` calls `:8080/healthz`.

## Health

`/healthz` (on both listeners) needs no authentication and holds no secrets or slugs.

- On the Admin listener it returns `{status, db, plugins, pendingApprovals, lastSyncAgeSeconds}`.
- On the MCP listener it returns only the overall status.
- The details of each instance are only in `/api/overview`.

## Reverse proxy

- `mcp.example.com` → `:8080`. The proxy must pass `Mcp-Session-Id`, allow SSE (no buffering), and forward `X-Forwarded-Proto` and `Host`.
- `admin.lan`, or a host on a VPN only → `:8081`. Do not publish it on the internet. If it must be remote, put it behind Cloudflare Access or Authelia, in addition to the portal sign-in.
- `TRUST_PROXY=true`, or a number of proxies (for example `2`), makes core use `X-Forwarded-*`. Core then takes the client IP (for rate limits and audit), the scheme and the cookie `Secure` flag from these headers.
- Core reads `X-Forwarded-For` from the right. The entry that the outermost trusted proxy added is the client. Core ignores the entries to its left, because the client sent them.

## Environment

The full list is in `.env.example`: `DATA_DIR`, `MASTER_KEY`, `MCP_HOST`, `MCP_PORT`, `ADMIN_HOST`, `ADMIN_PORT`, `PUBLIC_MCP_URL`, `PUBLIC_ADMIN_URL`, `MCP_ALLOWED_HOSTS`, `TRUST_PROXY`, `ADMIN_BOOTSTRAP_USERNAME`, `ADMIN_BOOTSTRAP_PASSWORD`, `ADMIN_FORCE_LOCAL_LOGIN`, `LOG_LEVEL`.

## Server log

Core writes one `LEVEL message key=value` line for each event to stdout or stderr, filtered by `LOG_LEVEL`.

- **Refused MCP requests.** Core logs the reason. The client never gets it. The reason is one of these:
  - the authentication mode and the kind of credential (never its value);
  - the `iss` and `aud` that a Cloudflare Access assertion claims;
  - a `Host` or `Origin` outside the allowed set;
  - an endpoint that is not available;
  - the JSON-RPC error of the transport.
- **Levels.** A request with a token-shaped credential logs at `warn`. Probes and bad headers log at `debug`, also the first step of OAuth discovery without credentials.
- **Throttle.** Core logs one refusal for each client IP and status in each minute. The next line gives the number of lines it did not write.
- The reason is a quoted and shortened field, because it can quote claims that are not verified.
- `info` adds each new MCP session. `debug` adds one line for each request on the MCP listener, with the path only, because query strings hold OAuth state.
- A proxy in front of core (for example Cloudflare Access) logs its own refusals. They never reach core.

## Network egress

Use a container network policy. Allow outbound traffic only to the upstream hosts, the ntfy and webhook targets, the OIDC issuer, and the plugin repository hosts. Core does not restrict the network access of plugins (§4.4).
