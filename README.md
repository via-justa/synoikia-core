<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/synoikia-lockup-dark.svg" />
    <img src="docs/assets/synoikia-lockup-light.svg" alt="Synoikia" height="72" />
  </picture>
</p>

<p align="center">
  <strong>Many households, one roof.</strong><br />
  One control plane for your self-hosted MCPs: every service behind a single MCP server, one admin portal and one permission gate.
</p>

<p align="center">
  <a href="#why-synoikia">Why</a> ·
  <a href="#core-features">Core features</a> ·
  <a href="#the-name">The name</a> ·
  <a href="#deployment">Deployment</a> ·
  <a href="#development">Development</a> ·
  <a href="docs/design/unified-mcp-server.md">Design</a> ·
  <a href="#contributing">Contributing</a>
</p>

---

Synoikia replaces a handful of separately deployed [MCP][mcp] servers with one, extended by plugins. Each plugin instance gets its own MCP endpoint, and every call from a model passes through the same sandbox, access levels and human approvals:

```
https://mcp.example.com/truenas   → TrueNAS plugin
https://mcp.example.com/seerr     → Seerr plugin
https://mcp.example.com/ha        → Home Assistant plugin
http://admin.lan:8081             → Admin portal (separate port, login required)
```

## Why Synoikia

Synoikia grew out of running several MCP servers next to each other ([TrueNAS][truenas], [Seerr][seerr], [Home Assistant][ha]) and hitting the same two problems with every one of them.

### 1. Tool definitions eat the context window

A typical MCP server exposes one [tool][mcp-tools] per operation, and every tool's name, description and schema is loaded into the model's context at the start of every session, whether it is used or not. The more of the API a server covers, the more it costs, so servers end up hand-curating a small subset and still paying tens of thousands of tokens for it.

Synoikia uses the [**Code Mode**][code-mode] pattern instead: each endpoint exposes exactly two tools. The model calls `search(code)` to find only the operations and schemas it needs for the task, then `execute(code)` to call them. The full catalog never enters the context, so the cost stays flat however large the upstream API is:

| Integration    | Classic MCP server                         | Context cost    | With Synoikia (2 tools)     |
| -------------- | ------------------------------------------ | --------------- | --------------------------- |
| TrueNAS        | 52 hand-picked tools                       | ~15–20K tokens  | ~1–3K, all ~650–700 methods |
| Home Assistant | 65 curated tools, growing with each domain | ~45–60K+ tokens | ~1–3K, every service        |
| Seerr          | 6 tools covering ~10% of the API           | ~1K tokens      | ~1–2K, 100% of the API      |

A naive one-tool-per-method wrapper of the TrueNAS API alone would cost over 100K tokens. _Estimates from the original per-server designs, now kept with each plugin in [synoikia-core-plugins][core-plugins]._

### 2. Every MCP server has its own idea of safety

Each server makes its own security decisions, and they rarely agree: some run every write immediately, some ask for approval through a prompt the calling client can answer itself, and some ship a raw "send any command" escape hatch. Authentication, secret handling and logging differ from server to server, and a destructive call such as wiping a disk or deleting a dataset is only as safe as the least careful implementation. Running them side by side also means separate processes, portals, databases and logins to keep secure.

Synoikia implements the security-critical parts **once, in core**, and applies them to every plugin: the sandbox, access levels, human approvals that the calling client can't give itself, redaction, the audit log and authentication. A plugin only describes its upstream API; it never decides what is allowed.

## Core features

**🔌 One server, many plugins.** Plugins are installed from plugin repositories, verified with [minisign][minisign] signatures. The [Synoikia plugins repository][core-plugins] ([TrueNAS][truenas], [Seerr][seerr], [Home Assistant][ha]) comes pre-configured, and you can add your own. Run several instances of the same plugin, each on its own endpoint.

**🧰 Two tools per endpoint.** Every endpoint exposes just `search(code)` and `execute(code)`. The model discovers operations and calls them with code that runs inside an [`isolated-vm`][isolated-vm] sandbox with no Node APIs, network or timers.

**🛂 A permission gate on every call.** Each operation has an access level, set per group with per-operation exceptions. New groups start at Ask. Whether an operation reads or writes comes from the upstream API (the HTTP method, or the roles a TrueNAS method requires), not from a guess:

| Level     | Behaviour                                                                   |
| --------- | --------------------------------------------------------------------------- |
| **None**  | Hidden from the model                                                       |
| **Read**  | Reads only                                                                  |
| **Ask**   | Writes wait for a human approval, unless a narrow pre-approval rule matches |
| **Write** | Writes run without asking, once acknowledged                                |

An operation's own level only offers what fits it: a read is None, Read or Ask (every call asks), a write None, Ask or Write.

**✋ Human approvals the model can't fake.** The MCP client asks you to open an approval page ([URL-mode elicitation][elicitation]), where you sign in and decide with your authenticator app. The client that made the call can't approve it. Destructive operations are `locked`: off until you set them to Ask, and then they always need a human, a typed confirmation and a fresh authenticator code, and can never be pre-approved or set to Write.

**🔐 Per-client ceilings.** Each connected client gets an access ceiling when you connect it (OAuth consent) or create its token: read only by default. MCP clients authenticate with [OAuth 2.1][oauth], bearer tokens or your existing reverse-proxy auth (such as [Cloudflare Access][cf-access] or [Authelia][authelia]).

**🧱 Isolated plugins.** Every plugin instance runs in its own child process under the [Node permission model][node-perm], with a scrubbed environment and a memory cap. Secrets are encrypted at rest and handed only to the instance that owns them.

**🙈 Secrets stay out of the transcript.** Passwords, tokens and keys are redacted from results, logs, approvals and the audit trail, including each instance's actual secret values wherever they appear in text.

**📜 Audit log and notifications.** Every call, decision and admin change is audited and exportable. [ntfy][ntfy] and signed webhooks tell you when something needs you.

**🖥️ An admin portal on your LAN.** A separate, login-protected port with local accounts, [TOTP][totp] and [OIDC][oidc] single sign-on, for endpoints, access levels, pre-approval rules, clients, plugins and settings.

**🔄 Self-maintaining catalogs.** Each instance re-syncs its operation catalog when the upstream version changes and on a daily schedule, and keeps serving the last good catalog if the upstream is briefly unreachable.

## The name

_Synoikia_ (Greek συνοικία) comes from _syn_ (σύν, "together") and _oikos_ (οἶκος, "house"): households living together. It shares its root with _synoikismos_, or [synoecism](https://en.wikipedia.org/wiki/Synoecism), the ancient Greek practice of joining separate villages into a single city. Athens traced its own founding to one, and marked it every year with a festival called the Synoikia.

That is what this project does for your MCP servers: services that used to run scattered, each with its own deployment and its own rules, now live under one roof and answer to one household.

<p align="center">
  <img src="docs/assets/synoikia-mark.svg" alt="" width="72" />
</p>

The mark draws the same idea: four identical dwellings, joined by paths to one shared hearth at the centre, inside the wall of the city.

## Status

The core is complete (design §13, phases 0–16): encryption, catalog sync with access levels, the permission-confined plugin host, the [`isolated-vm`][isolated-vm] sandbox, the permission gate with pre-approval rules and human approval, admin auth (local + TOTP + OIDC), MCP auth (external, bearer, OAuth 2.1), the Admin API and portal, ntfy/webhook notifications, plugin repositories with minisign signing, and maintenance jobs.

The TrueNAS, Seerr and Home Assistant plugins live in [synoikia-core-plugins][core-plugins] and are released there as a signed plugin repository. The full design is in [`docs/design/unified-mcp-server.md`](docs/design/unified-mcp-server.md), and the admin portal mockups it builds on are in [`docs/mockups/admin-portal`](docs/mockups/admin-portal/).

## Layout

| Path                  | What                                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/plugin-sdk` | Plugin manifest schema, core ⇄ plugin RPC contract, `runPlugin()` child runtime                                                                                 |
| `packages/core`       | Core process ([Hono][hono], [SQLite][better-sqlite3]): MCP listener (:8080), admin listener (:8081), plugin host, sandbox, permission gate, auth, notifications |
| `packages/admin-ui`   | [Vue 3][vue] admin portal (served by core on :8081)                                                                                                             |

## Development

Requires [Node.js][node] 22 (≥ 22.12) or 24 and [pnpm][pnpm] 10 (`corepack enable`).

```sh
pnpm install
pnpm test        # all packages (workspace deps resolve to TS sources, no build needed)
pnpm typecheck
pnpm lint
pnpm build
DATA_DIR=./data pnpm start   # MCP on :8080, admin on :8081; creates ./data/synoikia.sqlite + master.key
```

Admin UI with hot reload: run `pnpm start` in one shell and `pnpm --filter @synoikia/admin-ui dev` in another. [Vite][vite] proxies `/api` and `/auth` to `:8081`.

DB schema changes: edit `packages/core/src/db/schema.ts`, then `pnpm --filter @synoikia/core db:generate` ([Drizzle Kit][drizzle]).

### Publishing the plugin packages

Plugin repos, [synoikia-core-plugins][core-plugins] included, build against two npm packages: `@synoikia/plugin-sdk`, and `@synoikia/core` for its plugin test harness. To release either one, bump its `version` and merge to `main`. The Release workflow (`.github/workflows/release.yml`) publishes every package whose version isn't on npm yet, SDK first. It adds provenance only while this repo is public, because npm rejects provenance from private repositories.

It publishes through npm trusted publishing, so no token is stored: each package's settings on npmjs.com trust `via-justa/synoikia-core` and `release.yml`, with **Direct publishing** allowed. If the repository or the workflow file is renamed, update those settings too; trusted publishing doesn't follow renames. npm can only trust a publisher for a package that already exists, so a new package's first release has to be published once with a token (or by hand) before its trusted publisher can be set.

Prerelease versions (`0.3.0-rc.0`) are never published by a merge. Publish them by hand with **Actions → Release → Run workflow**; they go to the `next` dist-tag, so `latest` stays on the last release. A prerelease run is also the way to check trusted publishing after changing its settings: npm's verbose log (on for every release run) says why a publish was refused.

### Publishing the Docker image

The Docker image ships as one unit (core + admin-ui, plugin-sdk only as a build dependency), so it carries its own version, in the root `package.json`, decoupled from the SDK/core/admin-ui package versions above. To release a new image, bump that `version` and merge to `main`; the same `release.yml` builds and pushes `ghcr.io/via-justa/synoikia:<version>` (and moves `latest` to it, for stable versions) whenever that tag isn't already published. Prereleases follow the same manual-dispatch rule as the npm packages.

## Deployment

```sh
cp .env.example .env   # set MASTER_KEY, PUBLIC_MCP_URL, …
docker compose -f docker-compose.example.yml up -d
```

Pulls the published image from `ghcr.io/via-justa/synoikia` — `latest` tracks the newest stable release; pin an explicit version tag (e.g. `ghcr.io/via-justa/synoikia:0.2.0`) in production. Deploys with [Docker Compose][compose]. Put `:8080` behind your reverse proxy (such as [Caddy][caddy], [Traefik][traefik] or a [Cloudflare Tunnel][cf-tunnel]) as the public MCP hostname and set `PUBLIC_MCP_URL` to it. Keep `:8081` reachable from the LAN or VPN only. See design §11.

On first start, open the admin portal and create the first account (or set `ADMIN_BOOTSTRAP_USERNAME`/`ADMIN_BOOTSTRAP_PASSWORD` once). Then install and enable plugins, create an endpoint, raise the access groups you want above Read, and connect your MCP client to `PUBLIC_MCP_URL/<slug>`.

### Debugging a client that can't connect

A refused MCP request is logged with its reason: the auth mode, the kind of credential the client sent, a Cloudflare Access claim that didn't match, a Host outside `PUBLIC_MCP_URL`/`MCP_ALLOWED_HOSTS`, or an endpoint that is unavailable. Watch `docker compose logs -f synoikia` while the client connects. Set `LOG_LEVEL=debug` to also see every request on the MCP port, including OAuth discovery. If nothing shows up, the request was stopped before it reached Synoikia: check your proxy's log (for Cloudflare Access, Zero Trust → Logs → Access). See design §11.

### Plugin repositories

On first start Synoikia adds the [Synoikia plugins repository][core-plugins] with its signing key pinned:

- index: `https://github.com/via-justa/synoikia-core-plugins/releases/download/index/index.json`
- public key: `RWSDbQe7ylyyieEU0Yh/bxR53m+N/0VrVMru5WCzv1/Yvt5td92t/21e`

Install plugins from it on the Plugins page; every download is checked against that key. Removing the repository is permanent: it isn't added again on the next start. To add it back, add it as a signed repository with the URL and key above. Other repositories are added the same way, signed with their publisher's key or unsigned.

### Rotating the master key

Stop the server, then:

```sh
docker compose -f docker-compose.example.yml stop
# key file in the data volume: a new key is generated and written for you
docker compose -f docker-compose.example.yml run --rm synoikia node packages/core/dist/cli.js rotate-master-key
# MASTER_KEY from the environment: create the replacement first and keep it — it is the only copy
NEW_KEY="$(openssl rand -base64 32)"; echo "$NEW_KEY"
docker compose -f docker-compose.example.yml run --rm -e NEW_MASTER_KEY="$NEW_KEY" synoikia node packages/core/dist/cli.js rotate-master-key
# then set MASTER_KEY=$NEW_KEY in .env and start the server again
```

Every session is signed out afterwards.

## Contributing

Bug reports, feature requests and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for local setup and what CI checks before merge. Everyone participating is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Found a security issue? Please follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## License

[MIT](LICENSE)

<!-- External links -->

[core-plugins]: https://github.com/via-justa/synoikia-core-plugins
[mcp]: https://modelcontextprotocol.io/
[mcp-tools]: https://modelcontextprotocol.io/specification/2025-11-25/server/tools
[elicitation]: https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
[code-mode]: https://blog.cloudflare.com/code-mode/
[truenas]: https://www.truenas.com/
[seerr]: https://github.com/seerr-team/seerr
[ha]: https://www.home-assistant.io/
[isolated-vm]: https://github.com/laverdet/isolated-vm
[minisign]: https://jedisct1.github.io/minisign/
[oauth]: https://oauth.net/2.1/
[cf-access]: https://www.cloudflare.com/zero-trust/products/access/
[authelia]: https://www.authelia.com/
[node-perm]: https://nodejs.org/api/permissions.html
[ntfy]: https://ntfy.sh/
[totp]: https://datatracker.ietf.org/doc/html/rfc6238
[oidc]: https://openid.net/developers/how-connect-works/
[vue]: https://vuejs.org/
[hono]: https://hono.dev/
[better-sqlite3]: https://github.com/WiseLibs/better-sqlite3
[node]: https://nodejs.org/
[pnpm]: https://pnpm.io/
[vite]: https://vite.dev/
[drizzle]: https://orm.drizzle.team/docs/kit-overview
[compose]: https://docs.docker.com/compose/
[caddy]: https://caddyserver.com/
[traefik]: https://traefik.io/traefik/
[cf-tunnel]: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
