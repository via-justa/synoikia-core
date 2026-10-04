# Unified Pluggable MCP Server — Design Document

> Status: **Draft v1** · Grew out of three per-server designs (TrueNAS, Seerr, Home Assistant) and replaces
> their one-server-per-upstream deployment while keeping their permission model intact. Those designs now
> live with their plugins in [synoikia-core-plugins](https://github.com/via-justa/synoikia-core-plugins); the
> admin portal mockups are in [`docs/mockups/admin-portal`](../mockups/admin-portal/).

---

## 1. Purpose & Scope

The three source designs describe three servers that share one architecture: search/execute "Code Mode" tools, an `isolated-vm` sandbox, a call-time permission gate, and a SQLite-backed Vue Admin Portal. Built as written, you get three processes, three portals, three databases, three login surfaces, and three copies of the same security-critical gate.

This design merges them into **one server process with one Admin Portal and a plugin system**:

- Each integration (TrueNAS, Seerr, Home Assistant, and future ones) is a **plugin**.
- A plugin can run as one or more **instances**. Each instance has its own upstream connection, operation catalog, rules, and audit trail.
- Each instance is exposed as a **dedicated MCP endpoint** at an admin-chosen path slug: `https://mcp.example.com/truenas`, `/seerr`, `/ha`, `/ha-cabin`.
- The **Admin Portal runs on a separate port** from the MCP endpoints. It has a real login page (local accounts, optional OIDC, optional TOTP).
- The permission gate, sandbox, approvals, pre-approval rules, audit log, auth, and notifications are implemented **once, in core**. Plugins only provide the upstream-specific parts: catalog discovery, classification seeds, target resolution, and the actual upstream call.

### 1.1 What carries over unchanged from the source docs

These decisions are not reopened. Each is now implemented once in core and applies to every plugin:

- **Two MCP tools per endpoint:** `search(code)` and `execute(code)`.
- **Fail-closed classification.** Precedence is `locked` > `override` > inferred/default. Ambiguous cases default to `write`.
- **Reachability is a separate gate from classification**, and every endpoint starts at Ask (reads run, writes ask). What changes is _how_ it is controlled: an access level per group instead of a toggle per operation (§1.2, §5.2.1).
- **Call-time interception.** The bound function is the sandbox's only egress and the only enforcement point.
- **Approvals.** Approvals happen through the MCP client's prompts (elicitation). Unanswered approvals are auto-denied after 15 min. Approvals are single-use and scoped to the exact params (and resolved targets). What changes is _who_ can approve (§1.2, §5.3).
- **Typed confirmation** for `locked` operations.
- **Pre-approval rules.** Picked from the synced catalog, never free text. Rules have structured `match`, a rate limit that falls back to a human, expiry, and a required reason. Rules can **never** reference a `locked` operation; the API returns 409.
- **API-enforced locks.** Classification changes on `locked` rows are rejected with 409 at the API, not only hidden in the UI.
- **Redaction** on reads and writes, in model output, logs, and the portal.
- **Append-only audit log**, including configuration changes.
- **Maintenance cadence.** Session-start debounced sync, version-triggered sync, daily cron backstop, and mid-session recheck.
- **Upstream credentials.** Encrypted at rest, write-only through the API, and never inside the sandbox.
- **Rules specific to one upstream stay as specified, now owned by its plugin:** for example no raw-command escape hatch, surgical config edits with optimistic locking, best-practice attestation, GET-as-action detection and an on-behalf-of approval policy. Core provides the generic hooks they use (§3).
- **TDD phase discipline**.

### 1.2 What changes, and why

| Source-doc decision                                                              | Unified decision                                                                                                                                                                                                                 | Why                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FastMCP per server                                                               | **Official `@modelcontextprotocol/sdk`**, one Streamable HTTP transport per endpoint path, all on one **Hono** listener                                                                                                          | FastMCP assumes one server per HTTP listener. We need N endpoints on one port. FastMCP is a thin wrapper over the SDK, so no capability is lost: elicitation is `server.elicitInput()`, and sessions come from the transport's session IDs. |
| One SQLite DB per server                                                         | **One SQLite DB** with instance-scoped tables                                                                                                                                                                                    | One portal and one audit log. Cross-instance views (the audit log across endpoints) are simple queries.                                                                                                                                     |
| Basic-auth via env vars                                                          | **Login page**: local users (argon2id) in the DB, optional TOTP, optional OIDC                                                                                                                                                   | Requested explicitly. Basic-auth has no logout, no 2FA, and no SSO.                                                                                                                                                                         |
| Portal on the same process/port or "as a module in the Vue frontend"             | **Admin listener on its own port (8081)**, MCP listener on 8080                                                                                                                                                                  | Requested explicitly. The public reverse proxy only ever forwards 8080, so the admin surface is not internet-reachable by construction.                                                                                                     |
| MCP transport auth = "bearer token if exposed"                                   | **Four auth modes**, a global default plus a per-endpoint override: `external`, `bearer`, `oauth`, `bearer+oauth` (§6.2)                                                                                                         | Remote clients such as claude.ai custom connectors need OAuth. CLI and automation clients want static tokens. Self-hosted setups often already run Cloudflare Access or Authelia.                                                           |
| Notification channel deferred                                                    | **ntfy + generic webhook in v1**, informational only: endpoint down/recovered, plugin crashes, sync failures, new writes, sign-in lockouts (§9)                                                                                  | Several endpoints in one server fail in more ways than one; operators want to hear about it. Approvals are not delivered this way (§5.3).                                                                                                   |
| Per-operation Enabled toggle                                                     | **Access levels** — `none` / `read` / `ask` / `write` — set per plugin-derived group (a method namespace, an API tag, a service domain) as a convenience, with an optional level per operation that wins over its group (§5.2.1) | Hundreds to 1,000+ rows per instance made per-op toggles unmanageable. One control per resource ("apps: ask") works the same for every plugin and keeps auto-discovery; a per-operation level handles the exceptions.                       |
| Elicitation answers approve calls; portal inbox; approval links in notifications | **Approvals only on a page the server renders to a signed-in human with TOTP**, reached through a URL-mode elicitation prompt; form prompts can only approve plain writes where an endpoint opts in; no portal inbox (§5.3)      | A form answer comes back through the MCP client that made the call, so a scripted or prompt-injected client can "approve" its own writes. Cloudflare's own MCP server never treats a client-relayed answer as consent either (§5.3).        |
| Every connected client can reach writes the endpoint allows                      | **Access ceiling per credential**: the OAuth consent page offers Read only (default) or Read & write; bearer tokens carry the same field (§6.2)                                                                                  | The human who connects a client decides once what it may ever do, as on Cloudflare's consent page; everything after stays within that.                                                                                                      |
| One hard-coded integration per server                                            | **Dynamic plugins**, installed from HACS-style plugin repositories, signed or unsigned; the Synoikia plugins repository comes pre-configured (§4)                                                                                | Requested explicitly.                                                                                                                                                                                                                       |

### 1.3 Non-goals (v1)

- No RBAC. All portal users are full admins, which keeps the single-operator posture of the source designs. The user table exists so that OIDC, TOTP, and per-user audit attribution work.
- No horizontal scaling. One core process owns the SQLite file. Sync still takes a per-instance lock inside the process.
- No built-in TLS. TLS is terminated by the reverse proxy (Traefik, Caddy, or a Cloudflare Tunnel).
- No aggregated "all tools" endpoint. Each instance is its own MCP server by design.

---

## 2. Topology

```
                       Internet / LAN                                   LAN only
                  mcp.example.com (TLS @ proxy)                admin.lan (TLS @ proxy, optional)
                              │                                            │
┌─────────────────────────────┼────────────────────────────────────────────┼──────────────┐
│ Container                   ▼                                            ▼              │
│  ┌──────────────────────────────────────────────┐   ┌─────────────────────────────────┐ │
│  │ MCP listener :8080  (Hono)                   │   │ Admin listener :8081  (Hono)    │ │
│  │  /{slug}            Streamable HTTP MCP      │   │  /            Vue SPA           │ │
│  │  /.well-known/oauth-*                        │   │  /api/*       Admin REST API    │ │
│  │  /oauth/authorize|token|register|consent     │   │  /auth/*      login, OIDC cb    │ │
│  │  /a/{token}         approval-link page       │   │  /healthz                       │ │
│  │  /healthz                                    │   └───────────────┬─────────────────┘ │
│  └──────────────┬───────────────────────────────┘                   │                   │
│                 │ endpoint auth (§6.2)                               │ session auth (§6.1)│
│                 ▼                                                    ▼                   │
│  ┌───────────────────────────────── core process ───────────────────────────────────┐   │
│  │  Endpoint registry ── MCP Server per instance (search, execute)                  │   │
│  │        │                                                                         │   │
│  │        ▼                                                                         │   │
│  │  Sandbox runner (isolated-vm) ── binding ──▶ Permission gate (§5)                │   │
│  │                                               │  attest → enable → targets →     │   │
│  │                                               │  classify → pre-approve → human  │   │
│  │                                               ▼                                  │   │
│  │  Approval service ◀──▶ URL elicitation → approval page (§5.3); notifiers (§9)    │   │
│  │  Plugin host (§4) ── IPC JSON-RPC ──┬──────────────┬──────────────┐              │   │
│  │  Scheduler (§10)   SQLite + crypto  │              │              │              │   │
│  └─────────────────────────────────────┼──────────────┼──────────────┼──────────────┘   │
│                                        ▼              ▼              ▼                  │
│                                  ┌──────────┐   ┌──────────┐   ┌──────────┐             │
│                                  │ truenas  │   │ seerr    │   │ ha       │  child      │
│                                  │ instance │   │ instance │   │ instance │  processes  │
│                                  └────┬─────┘   └────┬─────┘   └────┬─────┘             │
└───────────────────────────────────────┼──────────────┼──────────────┼───────────────────┘
                                        ▼              ▼              ▼
                                     TrueNAS         Seerr     Home Assistant
```

### 2.1 Listener separation

The two listeners are two separate Hono apps bound to two ports. **A route that belongs to one listener does not exist on the other.** For example, `GET :8080/api/instances` and `GET :8081/truenas` both return 404, and tests assert this (§13).

| Listener | Default        | Env                        | Serves                                                                                                          |
| -------- | -------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| MCP      | `0.0.0.0:8080` | `MCP_HOST`, `MCP_PORT`     | MCP endpoints, OAuth AS + protected-resource metadata, OAuth login/consent page, approval-link page, `/healthz` |
| Admin    | `0.0.0.0:8081` | `ADMIN_HOST`, `ADMIN_PORT` | SPA, Admin API, admin login and OIDC callback, `/healthz`                                                       |

`PUBLIC_MCP_URL` (for example `https://mcp.example.com`) is required for OAuth. It is the issuer and resource base in OAuth metadata and the base of the approval-page URLs sent to MCP clients. Until it is set, OAuth is off: the authorization-server routes and discovery documents answer 503, `WWW-Authenticate` carries no `resource_metadata`, OAuth access tokens are not accepted, and the Overview shows a warning. Bearer tokens keep working. The issuer is never taken from the request's `Host`, which a client controls; only the approval-page link, sent back to the same client, falls back to the request's origin. `PUBLIC_ADMIN_URL` is optional; it is used for OIDC redirect URIs and deep links in notifications.

The MCP port serves a **small, fixed set of HTML pages**: OAuth login, OAuth consent, and approval-link login/decision. These pages reuse the same user accounts and OIDC configuration as the admin portal. They issue **separate cookies** by purpose: a consent sign-in gets `syn_mcp_oauth` (`Path=/oauth`, session kind `oauth_ui`), an approval sign-in gets `syn_mcp_approve` (`Path=/a`, kind `approval_ui`), both with a short lifetime; the purpose follows from where the sign-in continues to. That cookie is not accepted by the Admin API. Holding it grants only "complete this OAuth consent" or "decide this one approval".

### 2.2 Endpoint routing

- `/{slug}` is the Streamable HTTP endpoint for the instance with that slug. `POST` carries JSON-RPC, `GET` carries the SSE stream, and `DELETE` ends the session. These are the SDK's `StreamableHTTPServerTransport` semantics.
- Slugs match `^[a-z0-9][a-z0-9-]{0,62}$`, are unique, and cannot use reserved words: `oauth`, `a`, `healthz`, `.well-known`, `api`, `auth`, `static`.
- **DNS-rebinding defence.** A request whose `Host` isn't `PUBLIC_MCP_URL`'s host, a name in `MCP_ALLOWED_HOSTS`, `localhost` or an IP literal is refused with 403, and so is a browser `Origin` outside the same set (MCP transport spec).
- A disabled instance, or an instance whose plugin is disabled, returns **503** with a JSON-RPC error body. A slug that doesn't exist returns **404**.
- Each instance has its own `McpServer` object exposing `search` and `execute`. Their tool descriptions are templated from the plugin manifest (binding name, a short upstream description) so the model sees `truenas.call(...)` on `/truenas` and `ha.call(...)` on `/ha`.
- MCP sessions are keyed by `(instance, Mcp-Session-Id)`. The session records the authenticated client identity (§6.2) and whether the client advertised the elicitation capability.

---

## 3. Plugin Model

### 3.1 Responsibilities split

| Concern                                                            | Core                            | Plugin                                                                   |
| ------------------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------ |
| MCP protocol, sessions, tool schemas                               | ✅                              |                                                                          |
| Endpoint and admin authentication                                  | ✅                              |                                                                          |
| Sandbox (`isolated-vm`) and binding injection                      | ✅                              | declares binding names                                                   |
| Group access levels, classification precedence, locked enforcement | ✅                              | supplies **group**, **inferred classification** and **locked seed list** |
| Pre-approval rule storage and evaluation                           | ✅ generic evaluator            | declares **matchable fields** per operation                              |
| Approval flow, typed confirmation, timeouts                        | ✅                              | supplies human **summary** and the **confirmation literal**              |
| Audit log, redaction engine                                        | ✅                              | declares **sensitive keys**                                              |
| DB, encryption, master key                                         | ✅                              | never sees the DB or the master key                                      |
| Upstream connection and credential use                             |                                 | ✅ receives only its own decrypted secrets                               |
| Catalog discovery (API introspection, OpenAPI specs)               |                                 | ✅                                                                       |
| Registry mirror (devices, rooms …)                                 | stores                          | ✅ produces                                                              |
| Target resolution (room → devices)                                 | calls                           | ✅                                                                       |
| Config-transform / optimistic locking                              | shows the diff, stores the hash | ✅ computes                                                              |
| Best-practice guides and attestation keys                          | issues and validates keys       | ✅ supplies guide content and version                                    |
| Dynamic picker options (installed apps, rooms)                     | renders                         | ✅ `optionsFor(source)`                                                  |

The rule behind the split: **anything that decides whether a call may reach the upstream lives in core.** A buggy or malicious plugin can only lie about _inputs_ to the gate: classification hints, locked seeds, summaries. It cannot skip the gate, because core only calls `invoke` after the gate passes. Trusting a plugin's hints is part of the plugin trust decision (§4.3).

### 3.2 Manifest (`manifest.json`)

Validated by a zod schema in `@synoikia/plugin-sdk`. Abridged example for a hypothetical smart-home hub, Acme:

```jsonc
{
  "id": "acme", // globally unique, [a-z0-9-]
  "name": "Acme Hub",
  "version": "1.0.0", // semver
  "sdk": "^0.2.0", // plugin-SDK range this plugin was built for
  "description": "Search/execute over the Acme Hub API.",
  "entry": "dist/index.js", // child-process entry, relative to the package root
  "binding": {
    "namespace": "acme", // sandbox global: acme.*
    "functions": ["call"], // acme.call(...)
    "searchApis": ["registry"], // extra read-only query APIs offered to search()
  },
  "labels": { "operation": "Operation", "operations": "Operations" }, // e.g. "Method(s)" for an RPC API
  "capabilities": {
    "registry": true, // produces registry entries
    "targets": true, // resolveTargets hook; pre-approval `targets` selector
    "attestation": true, // guides + best_practice_key
    "configTransform": true, // prepareWrite: diff + optimistic lock
  },
  "connection": {
    // rendered on the instance Connection page (§8.3)
    "schema": {
      "type": "object",
      "required": ["baseUrl", "token"],
      "properties": {
        "baseUrl": { "type": "string", "format": "uri", "title": "Base URL" },
        "token": { "type": "string", "title": "API token", "writeOnly": true },
      },
    },
    "ui": { "token": { "widget": "secret", "help": "Settings → API tokens" } },
  },
  "sensitiveKeys": ["access_token", "webhook_id"],
  "network": { "hosts": ["{{connection.baseUrl}}"] }, // declared intent, shown on install (§4.4)
  "targets": {
    // what resolved targets are, and the scopes rules can select them by (§5.2)
    "label": "Device",
    "registryKind": "device", // registry entries of this kind are the targets; the picker suggests them
    "scopes": [
      { "key": "room", "label": "Room", "registryKind": "room" },
      { "key": "type", "label": "Device type" },
    ],
  },
  "matchProfiles": {
    // reusable match-field sets, referenced by operations
    "light": [
      {
        "field": "$targets",
        "label": "Targets",
        "widget": "registry-picker",
        "options": { "scopes": ["room"], "filter": { "type": "light" } },
        "covers": ["/target"], // params subtrees the selector stands for (strict matching, §5.2)
      },
    ],
    "thermostat.set_temperature": [
      {
        "field": "$targets",
        "label": "Targets",
        "widget": "registry-picker",
        "options": { "scopes": [], "filter": { "type": "thermostat" } },
        "covers": ["/target"],
      },
      {
        "field": "/temperature",
        "label": "Temperature",
        "op": "range",
        "widget": "range",
        "options": { "unit": "°F" },
      },
    ],
  },
}
```

Secret fields (`writeOnly: true`) are the only connection fields that are encrypted and never returned by the API (§7.2). Every other connection field is plain config.

**Targets are the plugin's to define.** Core has no notion of rooms, devices or any other upstream concept. A plugin with `capabilities.targets` declares `targets`:

- `label`: what one target is called in the portal.
- `registryKind` (optional): the registry kind whose entries are the targets.
- `scopes`: the dimensions a rule can select targets by. Each has a `key` (lowercase), a `label`, and optionally a `registryKind` whose entry ids are its values.

Every target `resolveTargets` returns reports its value for each declared scope in `scopes[key]`, and registry entries may carry the same `scopes`. A `$targets` match field's `options` choose which declared scopes it offers (`scopes`, all when omitted) and fixed scope values that narrow the picker's suggestions (`filter`). The manifest is rejected if either names an undeclared scope.

### 3.3 RPC contract (core ⇄ plugin child)

Transport: the Node `child_process.fork` IPC channel, carrying JSON-RPC 2.0 messages. Each request has a timeout (default 30 s; `invoke` inherits the sandbox's remaining budget). The SDK's `runPlugin(handlers)` implements the child side, and the core `PluginHost` implements the parent side. All types are exported from `@synoikia/plugin-sdk`.

| Method                                                                                 | Required             | Purpose                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init({ instanceId, config, secrets, sdkVersion })`                                    | ✅                   | Called once after spawn. The only time secrets cross the boundary.                                                                                                                                                                                                        |
| `testConnection()` → `{ ok, message?, upstreamVersion? }`                              | ✅                   | Connection page "Test connection". Rate-limited by core.                                                                                                                                                                                                                  |
| `getUpstreamVersion()` → `string`                                                      | ✅                   | Cheap version probe for version-triggered sync.                                                                                                                                                                                                                           |
| `syncCatalog()` → `{ upstreamVersion, sourceRef?, operations: OperationDescriptor[] }` | ✅                   | Full catalog. Core diffs it into `operations` and marks missing rows `stale`.                                                                                                                                                                                             |
| `syncRegistry()` → `RegistryEntry[]`                                                   | if `registry`        | Mirror of pickable upstream objects: `{ kind, id, name, parentId?, scopes?, attrs? }`, kinds chosen by the plugin.                                                                                                                                                        |
| `resolveOperation(fn, args)` → `{ key, params }`                                       | ✅                   | Maps a raw binding call to a catalog key: `call("pool.query", p)` → key `pool.query`, or `request({method:"POST", path:"/request", body})` → key `POST /request` via path-template matching. An unknown operation throws, and core records `rejected: unknown_operation`. |
| `resolveTargets(key, params)` → `ResolvedTarget[]`                                     | if `targets`         | Expands the call's targets to concrete ones, `{ kind, id, name, scopes }` with a value for each declared scope, using the plugin's current view. **Must throw** on an unknown target or scope value (fail closed).                                                        |
| `summarize(key, params, targets)` → `{ text, confirmLiteral? }`                        | ✅                   | The human sentence for approvals ("This will unlock **Front Door**"). `confirmLiteral` is the string the approver must type for locked operations (a dataset name, a device name).                                                                                        |
| `prepareWrite(key, params)` → `{ params, diff, expectedHash }`                         | if `configTransform` | Applies a transform against the current object. Throws `ConfigConflict` if the submitted hash is stale. Core shows the diff in the approval prompt and passes `expectedHash` back to `invoke`.                                                                            |
| `invoke(key, params, ctx)` → `unknown`                                                 | ✅                   | Performs the upstream call. Core calls it **only after the gate passes**. Upstream permission errors map to a structured `UpstreamDenied` error.                                                                                                                          |
| `optionsFor(source, query?)` → `{ value, label, meta? }[]`                             | optional             | Dynamic options for admin pickers, such as installed apps or media types.                                                                                                                                                                                                 |
| `getGuide(key)` → `{ version, content }`                                               | if `attestation`     | Best-practice guide. Core hashes `(instance, key, version, MCP session)` into the attestation key.                                                                                                                                                                        |
| `shutdown()`                                                                           | ✅                   | Graceful stop.                                                                                                                                                                                                                                                            |

The child can also send **notifications**: `log`, and `catalogChanged` (for example, the upstream announcing a newly installed integration so core can schedule a sync early).

**`OperationDescriptor`**:

```ts
{
  key: string;                          // stable catalog key, unique per instance
  displayName?: string;
  kind: string;                         // plugin-defined: 'method' | 'rest' | 'service' | 'ws_command' …
  group: string;                        // access group (§5.2.1): method namespace / API tag / service domain
  groupLabel?: string;                  // display name for the group, e.g. "Apps"
  tag?: string;                         // free-form filter tag; not used for access
  classification: 'read' | 'write';     // plugin's inferred default (naming / verb / command-shape)
  classificationReason: string;         // 'naming:.query' | 'verb:GET' | 'call_service-default' …
  locked?: boolean;                     // seeded locked
  typedConfirmation?: boolean;          // default false; core forces it on locked operations
  attestationRequired?: boolean;
  needsReview?: boolean;                // flag for the "New/Review" badge (e.g. a GET that performs an action)
  matchProfile?: string;                // key into manifest.matchProfiles
  paramsSchema?: JSONSchema;            // for search() results and portal display
  docs?: { summary?: string; description?: string; guidance?: string };
}
```

### 3.4 Splitting operations by risk

How each Synoikia plugin maps its upstream onto these hooks is documented with the plugin, in [synoikia-core-plugins](https://github.com/via-justa/synoikia-core-plugins).

One pattern is general: **when the risk of an operation depends on its params or targets, the plugin splits it into distinct catalog keys** in `resolveOperation`. For example, opening a cover becomes `cover.open_cover#garage` when any resolved target is a garage door, and only that key is seeded `locked`. This keeps `locked` a property of a catalog row, so it stays enforceable by core with a 409, and it keeps the gate generic.

---

## 4. Plugin Lifecycle & Distribution

### 4.1 Sources

Every plugin is installed from a plugin repository (§4.2) into `/data/plugins/<id>/`, one version at a time, swapped atomically. Trust follows the repository's signing mode (§4.3).

**The Synoikia plugins repository is pre-configured.** On first start core adds [synoikia-core-plugins](https://github.com/via-justa/synoikia-core-plugins) as a signed repository with its public key pinned from core's source, so no out-of-band confirmation is needed. It is added once, as a `system` audit event: an admin who removes it keeps it removed. Its index is fetched by the regular refresh, and an unreachable index is recorded on the repository, never fatal.

At startup the plugin host scans `/data/plugins`, validates every `manifest.json` against the SDK schema and the `sdk` range, and upserts a `plugins` row. An invalid manifest is recorded with `status = 'invalid'` and an error message, and it is shown in the UI. It is never loaded. A plugin whose directory is gone is marked invalid too; its endpoints and history are kept.

**Every plugin has an `enabled` flag** that is toggled in the Plugins page. New plugins arrive **disabled**, and instances still have to be created explicitly. Disabling a plugin stops all its instances, and their endpoints return 503. Configuration and history are kept.

### 4.2 Plugin repositories (HACS-style index)

The admin adds a repository by URL on the Plugins → Repositories page. The URL points to an `index.json`:

```jsonc
{
  "schema": 1,
  "name": "Example community plugins",
  "homepage": "https://github.com/example/mcp-plugins",
  "publicKey": "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3", // optional, minisign/ed25519
  "plugins": [
    {
      "id": "unifi",
      "name": "UniFi Network",
      "description": "Search/execute over the UniFi controller API",
      "versions": [
        {
          "version": "0.3.1",
          "sdk": "^0.1.0",
          "minCoreVersion": "1.0.0",
          "url": "https://github.com/example/mcp-plugins/releases/download/unifi-0.3.1/unifi-0.3.1.tgz",
          "sha256": "9f2c…",
          "signature": "untrusted comment: …\nRWQ…", // required if the repo is signed
        },
      ],
    },
  ],
}
```

- The index is fetched when the repo is added, when someone clicks "Refresh", and daily; a repo whose last fetch failed is retried hourly. It is cached in `plugin_repos.index_cache`.
- The Plugins page lists available plugins across all repos. It shows the installed version and whether an update is available. **There are no automatic updates.** Every install or update is an explicit admin action on a pinned version. A new install arrives **disabled**; enabling it is the admin's review of its binding, capabilities, sensitive keys and network hosts. An update that changes any of those is disabled again (its endpoints stop, and the audit event lists what changed) until the admin re-enables it; other updates keep the plugin's enabled state.
- Tarballs contain a **prebuilt, self-contained** package: `manifest.json` plus the entry and everything it imports **inside the package directory**, typically a single bundle (`esbuild --bundle --platform=node`), which is how the Synoikia plugins are built. Under the permission model (§4.4) the child cannot read anything outside its directory, so an entry that imports from a shared `node_modules` fails to load. Discovery also rejects an entry whose real path (after symlinks) lies outside the directory. The server never runs `npm install` or build scripts. Archives may be flat or npm-pack style (one top-level `package/` directory). Extraction accepts only regular files and directories: links, devices, paths that escape the target, and archives over 50 MB compressed, 200 MB extracted or 5,000 entries all fail the install. The archive's manifest must name exactly the plugin id and version being installed.
- Plugin ID conflicts: the installed row records its `repo_id`, and only that repository can update it. When two repositories offer the same ID, the other one shows it as installed from elsewhere and refuses to install over it (`installed_from_elsewhere`); the admin uninstalls it first. A plugin no repository manages (built in before 0.3.0, or copied into `/data/plugins` by hand) is **adopted** by the first repository install of its ID: the files are replaced, the row and its endpoints are kept, and the plugin is left disabled until the admin reviews and re-enables it (audited as `plugin_adopted`).

### 4.3 Trust & signing (optional per repo)

When the admin adds a repo, they choose a **signing mode**:

- **Signed.** Core reads `publicKey` from the index and shows it with its key id. The admin must confirm it by pasting the **full public key** (`RW…`, or the whole `.pub` file) exactly as the publisher advertises it out of band. A key id alone is not enough, because the key's owner chooses it: a hijacked index could publish a different key under the same id. The key is then **pinned** on the `plugin_repos` row. Every install requires the tarball to match `sha256` **and** carry a valid ed25519 (minisign-format) signature over the tarball bytes from the pinned key. If a later index fetch shows a different `publicKey` (compared byte for byte, not by id), the repo is marked `key_changed`: installs and updates are blocked until the admin re-confirms with the new full key. Both minisign algorithms are accepted (`ED`, prehashed with BLAKE2b-512 and the default since minisign 0.8, and legacy `Ed`), and the global signature over the trusted comment is always checked.
- **Unsigned.** Only `sha256` is verified. Every install from an unsigned repo shows a warning and requires typing the plugin ID to confirm. The plugin is badged "unsigned" everywhere it appears.

Installation, update, removal, and repo add/remove/key-change are written to the audit log as `config` events.

### 4.4 Process isolation

**Every enabled instance runs in its own child process.** The child is spawned by `child_process.fork(entry)` with:

- **Node permission model** (`--permission`), with `--allow-fs-read` limited to the plugin's package directory (Node's own runtime needs no grant; verified on Node 22: reads outside the directory, any write, and spawning processes all fail with `ERR_ACCESS_DENIED`). There is no `--allow-fs-write`, `--allow-child-process`, `--allow-worker`, or `--allow-addons`. This follows the Node 22 permission model. The allow-list is set by core and cannot be widened by a plugin.
- **Scrubbed environment.** Only `NODE_ENV` and a `PLUGIN_INSTANCE_ID` are passed. `MASTER_KEY`, DB paths, and admin config are never visible.
- **Memory cap** via `--max-old-space-size` (default 256 MB, adjustable per instance).
- **Secrets arrive only via `init`** over IPC, decrypted by core for **that instance only**.
- **Supervision.** If the child crashes, the instance status becomes `error`. It restarts with exponential backoff (1 s → 60 s max), and the incident is audited and sent to notifiers (§9). Start, stop and restart run one at a time per instance; a stop or restart kills a child still in `init` instead of waiting for it, so at most one child per instance is ever alive. While the child is down, in-flight `execute` calls fail with a structured `PluginUnavailable` error. The permission gate itself does not fail open; it never needs the plugin in order to _deny_.
- **Known limit: network egress is not restricted.** The Node permission model does not cover network access. A malicious plugin can reach any host the container can. The manifest's `network.hosts` is a _declaration_ shown at install time, not enforcement. Container-level egress policy is the documented mitigation, and per-plugin egress control is an open decision (§14).

### 4.5 Testing a plugin end to end

A plugin proves itself against the real core from its **own** package. Core's test suite never names a plugin. Core exports a harness for this, `@synoikia/core/testing`, and a plugin adds `@synoikia/core` as a devDependency:

```ts
const h = await startPluginHarness({ pluginDir, connection: { baseUrl: fake.url, apiKey } });
h.setGroupLevel('scene', 'ask');
await h.execute(`return await acme.call('scene.delete', { id: 'evening' })`, {
  onApproval: (a) => a.approve(),
});
```

What `startPluginHarness` does:

- It copies the plugin's release files (`manifest.json`, `package.json` and the entry's top-level path) into a temporary data directory's `plugins/<id>`, where an install puts it.
- It boots core on that data directory with an in-memory database, enables the plugin as the Plugins page does, creates an instance and syncs it. The bundle runs as a permission-confined child, exactly as in production.
- A plugin whose entry isn't built fails with an error instead of being skipped. For this reason plugin `test` scripts build first.

The harness offers:

| Area       | What it provides                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Calls      | `execute(code, { onApproval })` and `search(code)` on the same path an MCP client uses; `onApproval` decides each approval like the approval page, typed confirmation included |
| Access     | `setGroupLevel`, `setOperationLevel`, `addRule`, as an admin sets them in the portal                                                                                           |
| Inspection | `operation(key)`, `operations()`, `registry()`, `audit({ operationKey })`, `instance()`, `approvalErrors`                                                                      |
| Upstream   | `testConnection(connection)`, `syncNow()`                                                                                                                                      |
| Lifecycle  | `stop()` shuts core down and removes the temporary directory                                                                                                                   |

**Releasing a plugin repository.** `verifyPluginRepository({ index, assets, publicKey })`, from the same package, checks a built repository before it is published: core's own repository service adds it as a signed repository with `publicKey` pinned, installs the newest version of every plugin (sha256, signature, archive checks), then starts each bundle as a permission-confined child, as in production, and requires it to answer over IPC. A release workflow runs it after signing and before uploading anything.

---

## 5. Call Path & Permission Gate

### 5.1 `search(code)`

1. The code runs in a fresh `isolated-vm` context (§5.4).
2. Injected read-only APIs, all served by core from the DB (they never call the plugin):
   - `catalog.find({ text?, group?, tag?, kind?, classification?, includeDisabled? })` → descriptors. By default this returns **callable operations only** (§5.2.1), each with `approval: 'none' | 'required' | 'auto'` (runs, asks a human, or is auto-approved at level `write`). When `includeDisabled` is set, the others are included and tagged `disabled` with their `reason` (`level_none`, `token_read_only`, `locked_not_opted_in`).
   - `catalog.groups()` → `{ key, label, level, counts: { read, write, locked, pendingReview, overridden } }[]`, so the model can explain why something isn't callable ("apps are read-only on this endpoint").
   - `catalog.get(key)` → the full descriptor with `paramsSchema` and docs.
   - `registry.find({ kind?, text?, parent?, scopes? })` (only if the plugin has `registry`) → matched entries only, never the whole registry. `scopes` matches entries whose scope values equal the ones given.
   - `guides.get(key)` (only if `attestation`) → `{ content, best_practice_key }`. The key is `HMAC(server_secret, instance ‖ key ‖ guideVersion ‖ mcpSessionId)`, so it only works in the MCP session that read the guide; a key copied into another session or conversation is refused. Each guide read is audited (`search` / `guide_read`, with the guide version and session).
3. The return value is redacted (§5.5), size-capped (default 64 KB, truncated with a marker), and audited as a `search` event.

### 5.2 `execute(code)` and the binding

The sandbox receives `<namespace>.<fn>(...)` for each function in `manifest.binding.functions`. Each call runs this pipeline:

```
binding(args)
  │
  ├─ 0. resolveOperation (plugin)      → key, params         | unknown → UnknownOperation
  ├─ 1. attestation (if op.attestation_required)             | AttestationRequired
  ├─ 2. access level (§5.2.1) under the principal's ceiling  | OperationDisabled{reason}
  │      mode run (read) · approve (asks) · auto (write at level `write`)
  ├─ 3. resolveTargets (plugin, if capability)               | TargetResolutionFailed   (fail closed)
  ├─ 4. prepareWrite (plugin, if configTransform & write)    | ConfigConflict
  │      run  → invoke
  │      auto → invoke (auto-approved:level)
  │      approve:
  ├─ 6. pre-approval (level ask only, never locked)  match & unexpired & under rate limit → invoke (auto-approved:<rule>)
  ├─ 7. human approval (§5.3)          approved → access re-checked → invoke | denied/timeout → PermissionDenied
  ├─ 8. invoke (plugin)                                       | UpstreamDenied / UpstreamError
  ├─ 9. redact result (§5.5)
  └─ 10. audit (every branch above, including rejections)
```

- **Invoke timeouts can't be undone.** When `invoke` times out, the upstream may still have carried the write out; there is no cancellation RPC. The call is audited `error:UPSTREAM_TIMEOUT` (meaning "outcome unknown", not "did not happen"), and every `invoke` carries a unique `context.callId` so a plugin whose upstream supports idempotency keys can pass it on and make a retry safe.
- Errors are thrown **into** the sandbox as catchable `Error`s with a `code` property. They never crash the host. Codes: `UNKNOWN_OPERATION`, `ATTESTATION_REQUIRED`, `OPERATION_DISABLED` (message says why: level None (including a write in a group at Read), a read-only connection, a locked operation nobody enabled, or disabled while its approval was open), `TARGET_RESOLUTION_FAILED`, `CONFIG_CONFLICT`, `PERMISSION_DENIED` (denied, declined in the client, timed out, or the client cannot approve), `RATE_LIMITED`, `UPSTREAM_DENIED`, `UPSTREAM_ERROR`, `UPSTREAM_TIMEOUT`, `PLUGIN_UNAVAILABLE`, `PLUGIN_ERROR`, `EXECUTION_ENDED`.
- `prepareWrite` (step 4) runs for write operations whose descriptor `kind` is `config`, on plugins that declare `configTransform`.
- **An `execute` ends with its sandbox.** When the script returns, throws or times out — or the MCP request is cancelled, or its session closes — calls it left behind are refused (`EXECUTION_ENDED`) and an approval still open is cancelled, so nothing reaches the upstream after the tool call has answered.
- Calls are serialized within one `execute` by default. While one call waits for approval, the whole `execute` blocks. Per-instance setting: `concurrentReadsDuringApproval` (default `false`).
- **Rate limiting.** `execute` and `search` runs per minute, per principal and instance (default 30; refused with `RATE_LIMITED` before an isolate is created), and upstream write calls per minute, per principal and instance (default 10; checked before any approval is requested, but charged only when the write actually runs, so denied or timed-out calls cost nothing). At most 4 sandboxes run at once per instance and 16 in total (`BUSY`), and each principal keeps at most 16 open MCP sessions (a new one closes its least recently used). These are separate from pre-approval rule rate limits.
- **Pre-approval match evaluator** (generic, core). A rule's `match` is a list of conditions. Every condition must hold (AND):
  - `{ field: "/json/pointer", op: "eq" | "in" | "prefix" | "range" | "bool", value }` is evaluated against the **normalized params**. A missing field means **no match**.
  - `{ field: "$targets", ids?: [], scopes?: { <key>: [] } }` holds only if **every** resolved target satisfies **all** the set selectors: its id is in `ids`, and for each scope key its value is one of those listed. A target with no value for a selected scope doesn't match. Zero resolved targets means no match. Rules can only use scope keys the operation's `$targets` field offers (§3.2).
  - **Matching is strict**: every parameter of the call must be covered by a condition (a condition on a path covers everything under it). A rule with a `$targets` condition also covers the params subtrees its field declares in `covers`, since the condition already checks every target they resolve to. A parameter the rule doesn't mention must be absent, unless the rule accepts it with `{ field, op: "any" }`; `{ field: "", op: "any" }` accepts any parameters and the UI marks it "not recommended". So an empty `match` only matches calls without parameters. When a rule's conditions held but the call carried parameters it doesn't accept, the rule records `strict_miss_at` and the rule list says so.
  - `prefix` matches at a path-segment boundary: `tank/media` matches `tank/media` and `tank/media/tv`, not `tank/media-private`.
  - `rate_limit` / `window_seconds` are enforced via `pre_approval_hits`. When the limit is hit, the call **falls back to human approval** instead of being rejected.

### 5.2.1 Access levels (replace per-operation Enabled toggles)

Every operation has an **access level**. Admins normally set it **per access group**, which the plugin derives during discovery (§3.4). Setting a group's level resets every operation in it to follow the group. An operation can be given **its own level**, which wins over its group until the group's level is set again (or ↺ puts it back).

Read or write comes from the upstream API, never from an admin: REST plugins use the HTTP method (`GET` reads), TrueNAS the roles a method requires (a `*_READ` or `READONLY_ADMIN` role makes it a read), and only methods that declare nothing fall back to naming. There is no classification override.

What a **group** level means for each kind of operation that follows it:

| Group level | Read operations | Write operations                                                             | Locked operations                                   |
| ----------- | --------------- | ---------------------------------------------------------------------------- | --------------------------------------------------- |
| `none`      | off             | off                                                                          | off                                                 |
| `read`      | run             | off                                                                          | off                                                 |
| `ask`       | run             | every call asks for approval (§5.3); pre-approval rules can cover some calls | only with the operation's **own** `ask` (see below) |
| `write`     | run             | run **without asking** once acknowledged                                     | only with its own `ask`; never auto-run             |

An operation's **own** level is one its kind allows, so there is no "write at level Read":

| Kind   | Own levels             | Meaning                                                           |
| ------ | ---------------------- | ----------------------------------------------------------------- |
| read   | `none`, `read`, `ask`  | off · runs · every call asks for approval                         |
| write  | `none`, `ask`, `write` | off · every call asks · runs without asking once acknowledged     |
| locked | `none`, `ask`          | off · every call asks, with a typed confirmation and a fresh TOTP |

**One pure function** in core (`packages/core/src/gate/access.ts`) decides this. The gate, `search`, and the portal all use it:

```
effectiveAccess(op, group, principal):
  group missing / unknown level        → hidden (group_missing)       -- fail closed
  level = levelInForce(op, group)       -- own level (narrowed to its kind), else the table above
  level == none                        → hidden (locked_not_opted_in for a locked op its group would open, else level_none)
  op is read (and not locked)          → run, or approve at its own ask
  principal.ceiling == read            → hidden (token_read_only)     -- consent / bearer ceiling, §6.2
  level == ask, or op.locked           → approve (a locked op never auto-runs)
  !op.write_acknowledged               → approve (pendingReview)
  otherwise                            → auto
```

**Locked operations** never follow their group into `ask` or `write`. Each one becomes callable only when the admin sets **that operation** to `ask`. `write` is refused for them (409 at the API, disabled in the UI). They always need a human, a typed confirmation, and a fresh TOTP on the approval page (§5.3), and can never be pre-approved.

**Acknowledgement.** `write` runs calls with nobody approving. Choosing it is the admin's acknowledgement; there is no extra confirmation step:

- Raising a group to `write` acknowledges every non-locked write in it (setting the level resets them to follow it). The audit event lists them.
- Setting one operation to `write` acknowledges it.
- Operations that appear in a **later sync**, in a group that already existed, get their own level so an opened group never exposes them by itself: reads `read`, writes `none` (in a group at `none` they just follow it). A `sync.pending_review` notification is sent for the new writes (§9). Operations in a brand-new group follow it.
- Writes still unacknowledged at level `write` (one that became a write, or changed, under a group at `write`) **ask** until an admin acknowledges them; the group shows "N to acknowledge".
- If a sync changes an operation's inferred classification from read to write, its acknowledgement is reset. So does a change to an acknowledged write's parameters schema, kind, match profile or lock, or its return from stale: the admin acknowledged what it was, not what it became. An own level that no longer fits the operation's new kind is narrowed (a read's `read` becomes `none` when it turns into a write).
- Each sync re-checks enabled pre-approval rules against the new catalog and the plugin's match profiles. Rules that no longer fit (a field removed or its operator changed) are disabled, audited (`rules_disabled_operation_changed`) and counted in the `sync.pending_review` notification.
- If a sync newly locks an operation, its own level is cleared, so it starts closed again.
- If a sync moves an operation to another group (the plugin regrouped it), it keeps the access it had: it gets its own level when following the new group would differ. A new group starts at `ask` and an existing one may be at `write`, so a regroup never opens an operation by itself.

**Defaults.** A newly discovered group starts at `ask`: reads run and every write asks for approval. Locked operations stay off until set to `ask` one by one. A connection's own ceiling (read only by default, §6.2) still keeps a client away from writes.

**Bulk actions** (Access page):

- One **"Set all groups…"** dropdown. Each choice applies after one confirmation, because it changes every group at once; like a single group, every operation goes back to following its group. Write acknowledges every non-locked write; locked operations still ask. It is audited as one `config` event with every group's before/after level and the writes it acknowledged.

**Regrouping.** The plugin's grouping is the default. The admin can **merge** groups (e.g. fold `app.image` into `app`) and **rename** labels. Merges are stored as aliases (`plugin_group → group_key`) and applied on every sync, so custom grouping survives re-discovery. Merging groups with different levels takes the **lower** level.

**Pre-approval rules** still target individual operations, and only apply at level `ask` (a write, or a read given its own `ask`). A rule on an operation that is hidden, or at `write` (where it runs anyway), is inert, and the rule list flags it.

**Migration to levels by kind (0010).** Own levels that don't fit their kind keep what they did: a read at `ask`/`write` ran, so it becomes `read`; a write at `read` was hidden, so `none`; a locked op at `read` becomes `none` and at `write` becomes `ask`. Classification overrides go back to the plugin's; where that flips read and write, the operation gets its own `none` if it was off, else `ask`, so nothing opens wider than before.

**Migration from the three-level model.** The old `write` level asked for approval on every write, so it became `ask`; nothing started running without asking. Exclusions became the operation's own `none`. A locked operation's opt-in became its own `ask` where its group was at the old `write`.

### 5.3 Human approval

An approval must come from a person, never from the client that made the call. MCP form elicitation can't guarantee that: the answer comes back through the requesting client, so a scripted or prompt-injected client can "approve" its own writes, including typed confirmations it was shown. Cloudflare's MCP server (`cloudflare/mcp`) takes the same stance from the other side: it has no per-call approval, puts the human boundary on its own OAuth consent page (read-only by default), and leaves per-call confirmation to the client UI through tool annotations; its agents codemode resumes paused writes only from the application's own UI, never from the model. Here:

1. Core creates a `pending_approvals` row containing: instance, operation key, normalized params (redacted copy for display), `params_hash` (SHA-256 over canonical JSON of key + params + resolved targets + expected hash), summary, `confirm_literal`, diff, the requesting client identity, the MCP session, `expires_at` (default now + 15 min, set per instance).
2. **Channel** — exactly one, chosen from what the session's client advertised:
   - **URL-mode elicitation** (MCP 2025-11-25; the approval path). Core mints a single-use page token (`approval_links`, stored hashed, expiring with the approval) and calls `elicitInput({ mode: 'url', url: PUBLIC_MCP_URL/a/<token>, elicitationId, message })`. The human opens **our** approval page, signs in, and decides there; the client never sees the decision form or the literal. The client's reply only says whether the page was opened (`accept`); `decline`/`cancel` deny. After any decision core sends `notifications/elicitation/complete` and burns the token.
   - **Form elicitation**, only where the endpoint opted in (`formElicitationApprovals: 'writes'`, default `off`, with a portal warning) **and** the operation is a plain write (not locked, no typed confirmation). The form has just an `approve` boolean; the audit records `decided_via: elicitation` and the client as `decided_by`.
   - Otherwise the call is **denied at once**: `client_cannot_approve` for a form-only client, `no_approval_path` for a client without prompts.
3. **The approval page** (`/a/:token` on the MCP port) needs a signed-in portal user **with TOTP enrolled**, a TOTP proof in that session (password + TOTP sign-in counts; an OIDC sign-in is asked for a code when approving), and for **locked** operations a TOTP code from the last 5 minutes. Decisions are CSRF-protected POSTs; a GET or a prefetch decides nothing. `decided_by` is the username, `decided_via` is `url`.
4. **Typed confirmation.** For `typedConfirmation` operations, an approval only counts if the approver typed `confirm_literal` exactly on the approval page; a mismatch is rejected (400) and they can retry. The literal comes from the plugin's `summarize`, which receives **redacted** params, so neither the summary nor the literal can carry a secret. If a typed-confirmation operation gets no literal, the call is refused.
5. **Targets are re-checked** after a human approval, for plugins with `targets`: core resolves the params again right before `invoke`; if the set of targets differs from what the approver saw (an entity joined the area during the wait), the call is refused (`TARGETS_CHANGED`) and must be approved afresh. The approved set is passed to the plugin in `InvokeContext.targets`, which it should act on instead of resolving again.
6. **Access is re-checked** after the approval: if an admin lowered the level while it was open, the approved call is still refused (`access_changed`).
7. **Single use.** An approval authorizes exactly one `invoke` of exactly the `params_hash` it was created for. A re-submitted call creates a new approval.
8. **Timeout** → auto-deny, logged `timed-out`. It is never auto-allowed.
9. **Tool annotations.** `search` is `readOnlyHint: true`; `execute` is `readOnlyHint: false, destructiveHint: true, openWorldHint: true`, so clients that confirm tool calls themselves do. The gate never relies on them.
10. **Who may approve.** There are no roles: any enabled portal user who can sign in on the MCP port with TOTP may decide any approval, including one requested through their own OAuth grant, and auto-provisioned OIDC users are portal users. Keep the user list (and the OIDC allow policy) to the people who should hold that power; every decision records who made it.
11. **Values under redacted keys stay hidden on the approval page.** The page shows the same redacted params as the audit log, so for a write whose meaningful value sits under a sensitive key (setting an integration's `apiKey`), the approver sees `[REDACTED]`, not the value. This is deliberate: the approval page must not become a way to read secrets. Such operations should summarize what changes without the value (the plugin's `summarize` receives redacted params too).

### 5.4 Sandbox

- `isolated-vm`. **One isolate per `execute`/`search` invocation**, disposed afterwards. It is never reused across requests.
- Runtime: `isolated-vm` **6.2** (7.x requires Node 24; the image runs Node 22), loaded from its shipped prebuilds, with `node --no-node-snapshot` as isolated-vm requires on Node ≥ 20.
- `code` is the **body of an async function**: it can `await` bindings and `return` a JSON-serializable result. Everything crosses the boundary as JSON. Errors thrown inside the isolate, including binding errors, come back as `{ code, message }`, and a binding error is a real `Error` with `err.code` inside the sandbox so the model's code can catch it.
- Limits per call (instance-overridable): wall-clock 10 s _excluding time blocked on human approval_ (the binding pauses the budget while waiting; the approval timeout bounds the wait), memory 64 MB, result size 64 KB (larger results come back as `{ truncated, bytes, preview }`), logs 16 KB. The budget covers both synchronous loops (V8 timeout) and async loops (the isolate is disposed when it runs out).
- Injected: the binding functions (`ivm.Reference` with promise results), `catalog`/`registry`/`guides` (search only), and `console.log` (captured and returned as a `logs` array, size-capped).
- Not available: `require`, `import`, `process`, `fetch`, timers (`setTimeout` is not provided), and host objects. Binding namespaces are frozen. The host call/log references live only in the closure of a prelude script that runs before the user's code, which is compiled as a separate script and so can never name them; `__syn` is deleted from the global object, and the host only dispatches to its own binding properties (`Object.hasOwn`). This follows from the isolate having no Node APIs. An optional static pre-scan rejects obvious escape attempts early as defense in depth.

### 5.5 Redaction

A core engine walks results, params, and summaries and replaces values with `"[REDACTED]"` for any key matching:

- the global list: `password`, `passphrase`, `secret`, `token`, `apiKey`, `privateKey`, `bindpw`, `authPass`, `accessToken`, `refreshToken`, `clientSecret`, `authorization`, `credential`, `cookie`, `passwd`, `pass`, `pwd`
- the plugin's `sensitiveKeys`
- the instance's extra keys, configured in the portal

Params can also hold a secret with no key name, such as a password passed as the second positional argument. An operation descriptor declares those as `sensitiveParams`, JSON-pointer paths into its params (`/1`, `/0/password`). Core replaces them with `"[REDACTED]"` wherever params are shown or stored: the plugin's `summarize` input, pending approvals and their notifications, and the audit log. The plugin's `invoke` still gets the real values.

A config diff (`prepareWrite`) names each changed field in a path (`/smtp/password`), so redaction by key would miss it: an entry whose path has a sensitive segment, or sits at or under a `sensitiveParams` path, has its `before` and `after` hidden before the diff is stored or shown. A `__proto__` key in params stays a visible key in every redacted copy, so approvers and the audit log see everything the plugin will get.

Keys compare case-insensitively, ignoring `_` and `-`. A key matches a rule exactly or by containing it (`db_password`, `X-Api-Key`, `ssh_private_key`); rules under five characters (`pass`, `pwd`) only match as the key's last word (`smtp_pass`), so `bypass` stays visible. Under a contained match, booleans and numbers stay visible (`password_set: true`, `max_tokens: 4096`).

Text has no keys to go by, so each instance's redactor also **scrubs the instance's actual secret values** (and their URL/JSON-escaped forms, if at least 6 characters long) out of every string. Inside the sandbox, redaction applies to everything that leaves it: the result (before an oversized result is cut into its preview), every `console.log` argument (before it is turned into text), and error messages; `registry.find` redacts mirrored attributes at the source, and plugin/upstream error messages are scrubbed before they reach the model.

It is applied (a) to results returned to the model, (b) to everything written to the audit log and pending approvals, and (c) to anything rendered in the portal. For approval integrity, the unredacted params are held **only in memory** while the call is pending. The DB stores the redacted display copy plus `params_hash`. On a graceful shutdown (SIGTERM/SIGINT) open approvals are cancelled first, so waiting clients are told the call was denied; then MCP sessions and portal event streams are closed, the listeners stop with a 5 s grace before remaining connections are cut, and finally plugin children and the database are stopped. When an endpoint is stopped (disabled, deleted, its plugin disabled, or restarted after a connection change), its open approvals are cancelled the same way: an approval never outlives the plugin process and configuration it was asked for. Pending rows left by a crash are **auto-denied** at the next start (`denied: server_restart`), because the in-memory params are gone. This is intentional: an approval must never cover params the approver did not see.

---

## 6. Authentication

### 6.1 Admin portal login (port 8081)

- **Local users** (`users` table): username + argon2id password hash (`m=64 MiB, t=3, p=1`). There are no roles; every user is an admin.
- **First-run setup.** If no users exist, the SPA shows a one-time **Setup** screen to create the first user. The setup endpoint is **only** available while the users table is empty. Alternative for headless installs: `ADMIN_BOOTSTRAP_USERNAME` + `ADMIN_BOOTSTRAP_PASSWORD` create the first user on boot if the table is empty. After that they are ignored, and a warning is logged if they are still set.
- **TOTP (optional, per user).** RFC 6238, enrolled from the user's profile with a QR code. The secret is encrypted with the master key. Ten single-use recovery codes are generated (stored hashed). Setting `security.requireTotp` forces enrollment on next login.
- **OIDC (optional).** Configured in Settings → Authentication with: issuer URL (discovery), client ID/secret (secret encrypted), scopes, and an **allow policy** (allowed emails, allowed `sub`s, and/or a required group claim value). An email counts only when the ID token says `email_verified: true`; a missing claim is treated as unverified. Auth code flow + PKCE, with `state` and `nonce`.
  - `autoProvision` (default **off**): if off, an OIDC identity must be **linked** to an existing local user first (Profile → "Link OIDC identity"). If on, identities that pass the allow policy get a user created automatically.
  - **Break-glass.** Local password login always remains available unless `security.disableLocalLogin = true`. That setting can only be saved while OIDC is on and at least one enabled user is linked to it. While it is on, turning OIDC off, unlinking, or disabling the last enabled linked user is refused (409 `local_login_disabled`). It can be reverted with the env var `ADMIN_FORCE_LOCAL_LOGIN=true`.
- **Sessions.** Stored server-side (`sessions` table, random 256-bit ID, stored hashed). Cookie: `__Host-syn_admin` (`Secure` when behind TLS, `HttpOnly`, `SameSite=Strict`, `Path=/`). Idle timeout 30 min, absolute 12 h. Logout deletes the row. Changing a password revokes the user's other sessions.
- **CSRF.** A double-submit token: a non-HttpOnly `syn_csrf` cookie plus an `X-CSRF-Token` header on every state-changing `/api/*` request. `Origin` is also checked against `PUBLIC_ADMIN_URL` when that is set.
- **Brute-force protection.** 5 failed logins per username per 15 min triggers a 15 min lockout, counted **per surface**: failures on the internet-facing MCP-port sign-in lock the username there only, never out of the LAN admin portal. There is also a per-IP token bucket on `/auth/*` and `/api/instances/:id/connection/test` (against using it as a credential-testing oracle). Login failures are audited as `auth` events.

### 6.2 MCP endpoint authentication (port 8080)

The auth mode is a **global default** (Settings → MCP Access) with an optional **per-instance override** (Instance → Settings):

| Mode           | Accepts                                                                                                                                                                                                                                                                                                                                                                | Client identity recorded                                                                                                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `external`     | Anything that reaches the port. The reverse proxy is trusted to authenticate. Optional **Cloudflare Access JWT verification**: if `teamDomain` + `aud` are configured, the `Cf-Access-Jwt-Assertion` header must verify against the team's JWKS. Optional generic **trusted identity header** (e.g. `Remote-User` from Authelia/Authentik), used only for attribution. | JWT email (a service token's `service:<client id>` from `common_name`; an assertion naming nobody is refused) / header value / `"external (anonymous, <client IP>)"`; anonymous callers are kept apart by address |
| `bearer`       | `Authorization: Bearer syn_…` tokens issued in the portal                                                                                                                                                                                                                                                                                                              | Token name                                                                                                                                                                                                        |
| `oauth`        | OAuth 2.1 access tokens issued by the built-in authorization server                                                                                                                                                                                                                                                                                                    | OAuth client name + the user who consented                                                                                                                                                                        |
| `bearer+oauth` | Either of the above                                                                                                                                                                                                                                                                                                                                                    | as above                                                                                                                                                                                                          |

The UI shows a warning when `external` is chosen without JWT verification, because in that case port 8080 must never be reachable except through the proxy.

**Bearer tokens** (Clients & Tokens page):

- Format `syn_<base62 32 bytes>`. Shown **once** at creation and stored as SHA-256.
- Fields: name, **scope** (a list of instance IDs, or `*` for all), **access** (`read`, the default, or `write`), optional expiry, `last_used_at`, revoke.
- A token presented to an endpoint outside its scope gets **403**, not 401.

**Built-in OAuth 2.1 authorization server** (MCP authorization spec):

- **Protected-resource metadata** (RFC 9728) at `/.well-known/oauth-protected-resource/{slug}`, naming `PUBLIC_MCP_URL` as the authorization server. An unauthenticated request to `/{slug}` gets 401 with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/{slug}"`. Authentication comes before anything else about the endpoint: a disabled endpoint answers strangers exactly like an enabled one (503 only after authentication), and an unknown slug answers 401 with a plain `Bearer` challenge (404 only to holders of a live credential). The metadata carries no `resource_name`.
- **AS metadata** (RFC 8414) at `/.well-known/oauth-authorization-server`.
- **Dynamic client registration** (RFC 7591) at `/oauth/register`. It can be switched off globally (`oauth.allowDynamicRegistration`). If off, clients are pre-registered on the Clients & Tokens page. Registered clients are listed there with their redirect URIs and can be revoked.
- `/oauth/authorize`: authorization code flow, **PKCE S256 required**, and a `resource` parameter (RFC 8707) that must be one or more instance URLs. The user logs in on the minimal MCP-port login page (local password + TOTP, or OIDC; with `security.requireTotp` on, a user who hasn't enrolled TOTP is refused here, just as the portal forces enrollment), then sees a **consent screen** listing the client name, its redirect URI host, and the **endpoints requested**. The user can narrow the endpoint list before approving, and picks the **access ceiling**: **Read only** (preselected) or **Read & write**. The ceiling is stored on the grant, so every access and refresh token issued from it carries it; widening it needs a new consent. A `read` principal never reaches a write, whatever the endpoint's levels say (§5.2.1). `external` mode trusts the fronting proxy and is not limited here.
- `/oauth/token`: access tokens are opaque and short-lived (1 h), stored hashed, with audience = the granted resources. Refresh tokens rotate on every use (30 d sliding window, family revoked on reuse detection).
- Grants are bound to **instances, not slugs**: each consented resource URL is recorded with the instance it named at consent time, and tokens are checked against those ids. Renaming an endpoint keeps its grants working under the new slug; a new endpoint that takes over an old slug is not covered; deleting an endpoint revokes grants that covered nothing else.
- Consent grants are listed per user and client on the Clients & Tokens page and can be revoked. A user's grants (and their tokens) are also revoked when their password changes or they are disabled; disabling also revokes the bearer tokens they created, and `refresh` refuses a disabled user. Re-enabling a user revives none of them.

**Scope enforcement is the same for both token kinds.** Every request to `/{slug}` checks that the presented credential's scope or audience includes that instance.

---

## 7. Data Model

A single SQLite file at `DATA_DIR/synoikia.sqlite` (default `/data`), opened with **better-sqlite3** in WAL mode. Schema and migrations are managed with **Drizzle** (`packages/core/src/db/schema.ts`, `packages/core/drizzle/`). JSON is stored as `TEXT`, following the source docs.

### 7.1 Tables

```
-- identity & admin auth
users(id, username UNIQUE, password_hash NULL, totp_secret_enc NULL, totp_enabled, recovery_codes_hash TEXT,
      oidc_issuer NULL, oidc_subject NULL, created_at, last_login_at, disabled)
sessions(id_hash PK, user_id FK, kind 'admin'|'oauth_ui'|'approval_ui', created_at, last_seen_at, expires_at, ip, user_agent)
settings(key PK, value TEXT)                                   -- auth defaults, rate limits, flags; JSON values
oidc_config(id=1, issuer, client_id, client_secret_enc, scopes, allow_policy TEXT, auto_provision, enabled)

-- plugins
plugin_repos(id, url UNIQUE, name, signing_mode 'signed'|'unsigned', public_key NULL, key_fingerprint NULL,
             key_status 'ok'|'key_changed', index_cache TEXT, last_fetched_at, last_fetch_error)
plugins(id, plugin_id, version, source 'core'|'repo', repo_id NULL FK, path, sha256 NULL, signature_verified,
        manifest TEXT, status 'ok'|'invalid'|'incompatible', status_error, enabled, installed_at,
        UNIQUE(plugin_id))                                     -- one installed version per plugin id
plugin_instances(id, plugin_id FK, slug UNIQUE, display_name, enabled, config TEXT, secrets_enc BLOB,
                 auth_mode NULL,                                -- NULL = inherit global default
                 settings TEXT,                                 -- approval timeout, rate limits, sandbox limits…
                 status 'stopped'|'starting'|'ready'|'error', status_error,
                 upstream_version, source_ref, last_synced_at, last_sync_status, created_at)

-- catalog (instance-scoped; replaces the per-server methods/operations tables)
operation_groups(id, instance_id FK, key, label, level 'none'|'read'|'ask'|'write' DEFAULT 'read',
                 level_changed_at, level_changed_by FK users, first_seen_at, stale, UNIQUE(instance_id, key))
operation_group_aliases(instance_id FK, plugin_group, group_key, UNIQUE(instance_id, plugin_group))  -- admin regrouping
operations(id, instance_id FK, key, display_name, kind, tag,
           classification 'read'|'write',                       -- effective (locked implies write)
           classification_source 'locked'|'override'|'inferred',
           inferred_classification, inferred_reason,
           plugin_group, group_id FK operation_groups,
           locked, level_override 'none'|'read'|'ask'|'write' NULL,   -- NULL follows the group (§5.2.1)
           write_acknowledged, acknowledged_at, acknowledged_by,
           typed_confirmation, attestation_required, needs_review,
           match_profile, params_schema TEXT, sensitive_params TEXT, docs TEXT,
           first_seen_at, last_seen_at, stale,
           UNIQUE(instance_id, key))
registry_entries(id, instance_id FK, kind, ext_id, name, parent_ext_id, scopes TEXT, attrs TEXT, stale, last_synced_at,
                 UNIQUE(instance_id, kind, ext_id))
guides(id, instance_id FK, operation_id FK, version, content, fetched_at)

-- permission gate
pre_approval_rules(id, instance_id FK, operation_id FK, match TEXT, rate_limit, window_seconds, expires_at,
                   reason NOT NULL, enabled, created_by FK users, created_at, updated_at, last_triggered_at)
pre_approval_hits(id, rule_id FK, occurred_at)
pending_approvals(id, instance_id FK, operation_id FK, params_display TEXT, params_hash, resolved_targets TEXT,
                  summary, confirm_literal NULL, diff TEXT NULL, expected_hash NULL,
                  client_kind, client_id, mcp_session_id, requested_at, expires_at,
                  status 'pending'|'approved'|'denied'|'timed_out'|'cancelled',
                  decided_by NULL, decided_via 'elicitation'|'url' NULL, decided_at NULL)
audit_log(id, at, kind 'call'|'search'|'config'|'auth'|'plugin', instance_id NULL, operation_key NULL,
          classification NULL, decision NULL,  -- auto-executed | auto-approved:rule:<id> | human-approved | denied |
                                               -- timed-out | rejected:<reason>
          actor_kind 'mcp_client'|'user'|'system', actor_id, decided_by NULL, decided_via NULL,
          params TEXT NULL, resolved_targets TEXT NULL, result_status NULL, duration_ms NULL,
          detail TEXT NULL)                    -- config diffs, auth failures, plugin crashes

-- MCP client auth
mcp_tokens(id, name, token_hash UNIQUE, scope TEXT, access 'read'|'write' DEFAULT 'read',
           created_by, created_at, expires_at, last_used_at, revoked_at)
oauth_clients(id, client_id UNIQUE, client_secret_hash NULL, name, redirect_uris TEXT, registered_via 'dcr'|'admin',
              created_at, revoked_at)
oauth_grants(id, client_id FK, user_id FK, resources TEXT, access 'read'|'write' DEFAULT 'read', created_at, revoked_at)
oauth_codes(code_hash PK, grant_id FK, code_challenge, redirect_uri, resources TEXT, expires_at, used_at)
oauth_tokens(token_hash PK, grant_id FK, kind 'access'|'refresh', family_id, resources TEXT, expires_at, revoked_at)

-- notifications
notifier_channels(id, kind 'ntfy'|'webhook', name, config TEXT, secrets_enc BLOB, events TEXT, instance_filter TEXT,
                  enabled, last_sent_at, last_error)
approval_links(token_hash PK, approval_id FK, action 'view', expires_at, used_at)   -- approval-page tokens (§5.3)
```

JSON columns written by an earlier release (global `settings`, instance `settings`) are read **leniently**: a field the current schema rejects falls back to its default with a logged warning, instead of making every read throw. At startup those rejected fields are removed from the stored JSON once; valid fields are kept exactly as stored, so a later release's new defaults still apply to fields nobody set. Plugin manifests are re-validated by discovery on every start, and a plugin whose manifest no longer passes is marked unusable (its endpoints answer 503) rather than failing inside requests.

### 7.2 Secrets & master key

- `MASTER_KEY` (32 bytes, base64) comes from env. If unset, core reads or creates `DATA_DIR/master.key` (0600) on first boot and logs a prominent warning recommending that the key be moved out of the data volume.
- Encryption: AES-256-GCM with a random 96-bit nonce per value. The ciphertext blob is `v1 ‖ nonce ‖ ciphertext ‖ tag`, and the AAD is `table:column:row-id`, so a ciphertext can't be copied to another row.
- Encrypted columns: `plugin_instances.secrets_enc` (all `writeOnly` connection fields), `users.totp_secret_enc`, `oidc_config.client_secret_enc`, `notifier_channels.secrets_enc`.
- The Admin API **never returns decrypted secrets**. `GET` returns `{ set: true, hint: "…ab12" }` per secret field. `PUT` with a secret field replaces it. Omitting the field keeps the old value — **unless the same request changes where the upstream is** (a non-secret field with a `uri`/`hostname`/IP format, or named like `url`, `host`, `server`, `endpoint`, `address`). Then stored secrets are not carried over, for saves and for "Test connection" alike, and the request must enter them again (`400 secrets_required`); otherwise a changed URL would receive the stored key.
- Key rotation: `node dist/cli.js rotate-master-key`, run with the server stopped (a running server holds `DATA_DIR/server.lock` with its pid and host, and the command refuses to run while that process is alive, because a live server keeps the old key in memory and would write secrets under it afterwards; a lock written on another host, such as a server in another container on the same volume, always counts as held, and `--force` is the override once that server is known to be stopped), decrypts every encrypted column first and then re-encrypts them all in one transaction, so a wrong current key changes nothing. With a key file, the new key is written to `master.key.new` before the database changes and then moved over `master.key`. With `MASTER_KEY` in the environment, the replacement must be supplied as `NEW_MASTER_KEY`, so it exists before any data depends on it. All sessions are cleared, because their pepper is derived from the master key.
- Derived keys (HKDF from the master key): the attestation HMAC key, the signed-state key (MFA and consent forms), and the session-ID pepper. Approval-link tokens are random and stored as SHA-256 hashes, so they need no key.

### 7.3 Write ownership

| Writer                               | Tables                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Admin API (authenticated user)       | `users`, `settings`, `oidc_config`, `plugin_repos`, `plugins`, `plugin_instances`, `operation_groups.{level, label}`, `operation_group_aliases`, `operations.{classification_source=override, level_override, write_acknowledged, attestation_required}`, `pre_approval_rules`, `mcp_tokens`, `oauth_clients` (admin), `notifier_channels` |
| Sync jobs (core, from plugin output) | `operations` (insert, inferred fields, `stale`, `last_seen_at`, locked seeds, `write_acknowledged` reset on read→write or a changed descriptor), `pre_approval_rules.enabled` (off when a rule no longer fits), `operation_groups` (insert at `read`, `stale`), `registry_entries`, `guides`, instance sync columns                        |
| Gate / approval service              | `pending_approvals`, `pre_approval_hits`, `audit_log`                                                                                                                                                                                                                                                                                      |
| OAuth AS                             | `oauth_*`, `sessions(kind=oauth_ui)`                                                                                                                                                                                                                                                                                                       |
| Nobody (append-only)                 | `audit_log` rows are never updated or deleted through any API                                                                                                                                                                                                                                                                              |

Invariants, enforced in the service layer and tested:

- `locked` can only be set by sync from a plugin seed, and never cleared through the API. `PATCH` on the classification of a locked row returns 409.
- A `pre_approval_rules` row can never reference a locked operation. `POST`/`PATCH` return 409. A sync that newly locks an operation **disables** any existing rules on it and audits that.
- An operation with no group row is unreachable (`group_missing`). A group can only be raised to `write` together with the exact list of writes being acknowledged; a stale list returns 409.
- Operation and group levels are changed only through the Admin API, and every change is audited. Approval decisions are made only on the approval page (§5.3).
- Sandboxed code and plugin children have **no path** to any of these tables.

---

## 8. Admin Portal UI

Vue 3 + Vite + vue-router + Pinia, served as static assets by the admin listener. The layout follows the mockups (sidebar navigation, pill badges for `read`/`write`/`locked`, the toggle style from `Methods.dc.html`); the visual language is the Synoikia brand: warm plaster surfaces, terracotta for the one primary action per view, desaturated status colors, Fraunces for the wordmark, IBM Plex Sans and Mono for everything else, in light and dark themes.

### 8.1 Navigation

```
┌ Sidebar ───────────────────┐
│ ▣ Synoikia                 │
│                            │
│ Overview                   │  Endpoints dashboard (§8.2)
│ Audit Log                  │  global
│                            │
│ ENDPOINTS                  │
│ ▾ /truenas   ● Ready       │  instance group (expands when selected)
│     Connection             │
│     Access                 │  access levels (§5.2.1)
│     Pre-Approval Rules     │
│     Settings               │
│ ▸ /seerr     ● Ready       │
│ ▸ /ha        ● Error       │
│ + New endpoint             │
│                            │
│ Plugins                    │
│ Clients & Tokens           │
│ Settings                   │
│ ─────────────────────────  │
│ admin · Log out            │
└────────────────────────────┘
```

The per-instance pages are the mockup pages (Connection, Methods, Pre-Approval Rules), now scoped to one instance. The Audit Log is global, with an instance filter and an instance column.

### 8.2 Pages

| Page                                    | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Login**                               | Username/password, TOTP step if enabled, a "Sign in with <provider>" button when OIDC is enabled, and lockout messaging.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Setup**                               | Only while no users exist: create the first admin and optionally enroll TOTP.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Overview**                            | A card per instance: plugin, slug, full endpoint URL (copy button), auth mode (inherited or overridden), status, last sync. Plus plugin child health and notifier health.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Connection** _(per instance)_         | The `Main.dc.html` mockup, driven by the plugin's `connection` schema: fields, secret fields with a masked hint + "Rotate", Save, Test connection, status pill, Sync now, last synced, upstream version, count of synced operations, new since last sync, `sourceRef` (when the plugin records one). Plugin-provided help (`connection.help`) and conditional fields (`showWhen`, §8.3), e.g. a setup checklist for a dedicated upstream user and an API-key rotation warning.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Access** _(per instance)_             | Replaces the per-operation Enabled toggles of `Methods.dc.html` (that mockup predates §5.2.1; its row styling and badges still apply). A **group list**: label and key, a None / Read / Ask / Write segmented control (tooltips explain each), counts of read / write / locked operations, "N with their own level" and "N to acknowledge" badges, and NEW / STALE badges. Changing a group to Write opens the dialog listing the writes that will run without asking (§5.2.1). **Expanding a group** lists its operations (using `manifest.labels`, e.g. "Methods"): key, what a call does now (Runs / Asks / Runs without asking / why it's off), a **level select** ("Follow group", None, Read, Ask, Write; reads only offer None/Read; Write is disabled on locked rows, and setting a locked op to Ask or any write to Write asks for confirmation), the classification dropdown (hidden on locked rows), **Acknowledge** on writes that ask until acknowledged, and the `attestation_required` toggle (only for plugins with `attestation`; turning it off is remembered, so a later sync doesn't turn it back on). Page tools: search across all groups and operations, "Needs attention" filter, **Regroup** dialog (merge / rename), and bulk **All → None / Read / Ask / Write** (Write needs the typed-slug confirmation). |
| **Pre-Approval Rules** _(per instance)_ | The `PreApprovalRules.dc.html` mockup: rule list with rate limit and last triggered. Editor: operation picker (a searchable catalog list, **locked operations not offered**), match editor rendered from the operation's `matchProfile` (§8.4), rate limit, expiry, required reason, enabled. Warning banner for an empty match.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Instance Settings** _(per instance)_  | Display name, slug (renaming warns that clients must be reconfigured), enabled, auth-mode override, approval timeout, `formElicitationApprovals` (with a warning that any client could then approve its own writes), rate limits, sandbox limits, extra redaction keys, memory cap. Delete instance (typed confirmation of the slug; history is kept in the audit log).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Audit Log**                           | The `AuditLog.dc.html` mockup, plus columns for instance, kind, and actor. Filters: instance, kind (`call`/`search`/`config`/`auth`/`plugin`), decision, time range, operation, target entity. CSV export. Clicking an `auto-approved` row opens the rule and its edit history.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Plugins**                             | Tabs. **Installed**: source, version, signed/unsigned badge, status, enable toggle, instances using it, update available, uninstall (blocked while instances exist). **Available**: across repos, with install + permission/network declaration review. **Repositories**: add a URL, choose the signing mode, confirm the key fingerprint, refresh, key-changed banner, remove.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Clients & Tokens**                    | Bearer tokens (create with scope and expiry, shown once, revoke), OAuth clients (DCR + admin-registered, revoke), OAuth grants per user (revoke).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Settings**                            | _MCP Access_: default auth mode, Cloudflare Access config, trusted identity header, DCR on/off, `PUBLIC_MCP_URL` display. _Authentication_: OIDC config + allow policy + auto-provision, require TOTP, disable local login. _Users_: list/add/disable users, reset TOTP. _Notifications_: channels (§9). _Profile_: change password, TOTP enroll/reset, link OIDC.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### 8.3 Declarative plugin UI

Plugins never ship JavaScript to the admin origin. The places where plugin-specific UI is needed use JSON Schema + UI hints rendered by a **fixed core widget library**:

| Widget                                    | Used for                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`, `url`, `number`, `bool`, `select` | connection fields, scalar match fields                                                                                                                                                                                                                                                                                    |
| `secret`                                  | write-only credential fields (masked hint, rotate)                                                                                                                                                                                                                                                                        |
| `multiselect`                             | static options, or dynamic via `optionsFor(source)` (e.g. "app in: plex, sonarr"; mockup `PreApprovalRules.dc.html`)                                                                                                                                                                                                      |
| `prefix`                                  | path/name prefix match (e.g. a dataset name under `tank/apps`)                                                                                                                                                                                                                                                            |
| `range`                                   | numeric range with unit (thermostat 65–78 °F)                                                                                                                                                                                                                                                                             |
| `registry-picker`                         | Built from the plugin's `targets` (§3.2): one chips input per scope the field offers, suggested from that scope's registry kind if it has one, and one for target ids, searched in the targets' registry kind and narrowed by the field's `filter`. Backed by `GET /api/instances/:id/registry?kind=&text=&scope.<key>=`. |
| `diff`                                    | before/after field diff on the approval page                                                                                                                                                                                                                                                                              |

Adding a widget is a core change. Plugins can only reference widgets that exist. An unknown widget name in a manifest fails validation, so a plugin cannot silently degrade to a free-text field.

Connection fields can also carry `showWhen: { field, in: [...] }` to appear only for certain values of another field (e.g. email/password for `authMethod = local` and the API key for `authMethod = apiKey`). The manifest's `connection.help` (Markdown) is rendered above the form as a setup checklist. Conditional _requirements_ are expressed in the JSON Schema itself (`allOf` + `if`/`then`) and validated server-side.

### 8.4 Admin API (summary)

All routes are under `/api` on port 8081, need a session cookie and CSRF for mutations, and return JSON.

```
POST   /auth/login | /auth/totp | /auth/logout      GET /auth/oidc/start | /auth/oidc/callback
GET    /api/session                                  POST /api/setup (only while no users)
GET    /api/overview
GET    /api/plugins            PATCH /api/plugins/:id {enabled}        DELETE /api/plugins/:id
GET/POST/DELETE /api/plugin-repos    POST /api/plugin-repos/:id/refresh | /confirm-key {publicKey}
GET    /api/plugin-repos/available   POST /api/plugins/install {repoId, pluginId, version, confirm}
GET/POST /api/instances      GET/PATCH/DELETE /api/instances/:id
GET/PUT  /api/instances/:id/connection   POST /api/instances/:id/connection/test
POST   /api/instances/:id/sync
GET    /api/instances/:id/groups          PATCH /api/instances/:id/groups/:key {level?, label?, acknowledge?}
                                          (level=write requires acknowledge = exact list of writes that will run without asking; 409 if stale)
POST   /api/instances/:id/groups/merge {from: [keys], into, label?}
GET    /api/instances/:id/groups/bulk-level/preview?level=write
POST   /api/instances/:id/groups/bulk-level {level, confirm?, acknowledge?}   (write: confirm = slug, acknowledge = preview; 409 if stale)
GET    /api/instances/:id/operations?group=&q=&reason=
PATCH  /api/instances/:id/operations/:opId {level? (null = follow group), acknowledged?, classification?, attestationRequired?}
                                          (409 on locked classification, and on level=write for a locked op)
GET    /api/instances/:id/registry        GET /api/instances/:id/options/:source
GET/POST /api/instances/:id/rules         PATCH/DELETE /api/instances/:id/rules/:ruleId (409 on locked op)
GET    /api/audit                  GET /api/audit/export.csv
GET/POST/DELETE /api/tokens {name, scope, access, expiresAt}   GET/DELETE /api/oauth/clients   GET/DELETE /api/oauth/grants
GET/PUT  /api/settings/:section    GET/POST/PATCH/DELETE /api/users
GET/POST/PATCH/DELETE /api/notifiers   POST /api/notifiers/:id/test
GET    /api/events  (SSE: instance status, sync progress, lockouts)
```

Every mutating route writes a `config` audit event with a before/after diff (secrets redacted). The "configuration changes" filter is the `kind=config` filter.

---

## 9. Notifications (v1)

### 9.1 Channels

| Kind      | Config                                                                           | Delivery                                                                                                                                                                                                                     |
| --------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ntfy`    | server URL (default `https://ntfy.sh`), topic, optional access token (encrypted) | JSON publish to `POST {server}` (`topic`, `title`, `message`, `priority`, `tags`). JSON rather than headers so titles stay UTF-8 safe                                                                                        |
| `webhook` | URL, optional HMAC secret (encrypted), optional extra headers (encrypted)        | `POST` JSON `{event, at, instance, title, message, data}` with `X-Synoikia-Event`, `X-Synoikia-Timestamp` and `X-Synoikia-Signature: sha256=<HMAC-SHA256(secret, timestamp + "." + body)>`, so a receiver can reject replays |

Each channel subscribes to a set of **events** and can filter by instance:

- `instance.error`, `instance.recovered`, `plugin.crashed`
- `sync.failed`, `sync.pending_review` (new or changed writes, which ask until acknowledged where their level is Write, and rules the sync disabled)
- `auth.lockout` (once per lockout, when a username reaches the failure limit; the per-IP budget and the bounded throttle (§6.1) keep a flood of random usernames from turning into a flood of notifications faster than one per five failed attempts)

Delivery is retried with backoff (3 attempts; 4xx other than 429 is not retried). Failures update `last_error`, shown on Settings → Notifications, and every channel has a Test button. Notification bodies are built from the **redacted** summary and never contain raw params.

### 9.2 No approvals by notification

Notifications are informational. They never carry approve/deny links: approvals happen in the MCP client, which opens the approval page (§5.3). Channels saved while approval events existed keep working; the stale event names are dropped when the channel is read or saved.

---

## 10. Maintenance & Auto-Update (per instance)

The maintenance cadence of the source designs applies unchanged, each run **per instance** by the core scheduler:

- **Session-start sync, debounced.** On a new MCP session to `/{slug}`: if `last_synced_at` is older than `syncMaxAge` (default 1 h), or if `getUpstreamVersion()` ≠ `upstream_version`, run `syncCatalog` (+ `syncRegistry`) **before** serving the session's first `search`/`execute`. An in-process per-instance mutex means concurrent session starts share one sync.
- **Group mapping on sync.** Each operation's `plugin_group` is mapped through `operation_group_aliases`. Missing groups are created at `read`. Groups with no remaining operations are marked `stale` (their level is kept in case they return). New writes arrive unacknowledged: at level Write they ask until acknowledged (§5.2.1).
- **Cron backstop.** Daily, per instance (staggered). Also available as the "Sync now" button / `POST /api/instances/:id/sync`.
- **Mid-session recheck.** Every 30 min for sessions still open, a cheap version comparison. On mismatch, a sync runs before the next call.
- **Registry freshness.** `syncRegistry` runs on the same cadence, plus when the plugin sends `catalogChanged`. `resolveTargets` uses the plugin's live view, so scope membership (a target's room, say) is evaluated as of call time.
- **Sync failure.** Keep serving the last-synced catalog (fail open on _reading_ classifications), set `last_sync_status = error`, and notify `sync.failed`. If an instance has **no** prior sync and the upstream is unreachable, it stays in `error` and its endpoint returns 503 (refuse-to-start, now per instance, not for the whole process).
- **Plugin repo index refresh.** Daily. Surfaces update availability and key changes. It never installs anything.
- **Housekeeping (hourly).** Purge `pre_approval_hits` older than the largest rule window. Purge expired sessions, OAuth codes, tokens, and approval-page tokens. Purge decided approvals older than 7 days; the audit log keeps their record. `audit_log` has **no** automatic purge; an optional `audit.retentionDays` setting (default unset = keep forever) exists for disk hygiene and is itself audited.

---

## 11. Deployment

- **One image**, multi-stage build:
  1. `pnpm install --frozen-lockfile`
  2. build SDK → core → admin-ui
  3. runtime stage: `node:22-bookworm-slim` with the production `node_modules` (native: `better-sqlite3`, `isolated-vm`, `argon2`), `packages/core/dist`, and the admin-ui `dist` (served by core). No plugins: they are installed into the data volume
- Published to `ghcr.io/via-justa/synoikia` for `linux/amd64` and `linux/arm64`, tagged with the root `package.json`'s `version` (decoupled from the SDK/core/admin-ui package versions) plus `latest` for the newest stable release. Built and pushed by `.github/workflows/release.yml` on a version bump merged to `main`, same dedup/prerelease rules as the npm packages (README "Publishing the Docker image").
- Runs as a non-root user. `DATA_DIR=/data` is a volume. `EXPOSE 8080 8081`. `HEALTHCHECK` hits `:8080/healthz`.
- `/healthz` (both ports) returns `{status, db, plugins: {…instance: status}, pendingApprovals, lastSyncAgeSeconds}`. It is unauthenticated and contains no secrets or slugs; per-instance details are only on the admin port's `/api/overview`. On the MCP port it returns only an aggregate status.
- **Reverse proxy** (documented examples for Caddy, Traefik, and Cloudflare Tunnel):
  - `mcp.example.com` → `:8080`. Must pass `Mcp-Session-Id`, allow SSE (no buffering), and forward `X-Forwarded-Proto`/`Host`.
  - `admin.lan` (or a VPN-only hostname) → `:8081`. **Do not** publish it on the internet. If it must be remote, put it behind Cloudflare Access / Authelia in addition to the portal login.
  - `TRUST_PROXY=true` (or a hop count, e.g. `2` for two chained proxies) makes core honor `X-Forwarded-*` headers for client IP (rate limiting, audit), scheme, and cookie `Secure`. `X-Forwarded-For` is read **from the right**: the entry the outermost trusted proxy appended is the client; anything further left was sent by the client and is ignored.
- **Environment** (full list in `.env.example`): `DATA_DIR`, `MASTER_KEY`, `MCP_HOST`/`MCP_PORT`, `ADMIN_HOST`/`ADMIN_PORT`, `PUBLIC_MCP_URL`, `PUBLIC_ADMIN_URL`, `MCP_ALLOWED_HOSTS`, `TRUST_PROXY`, `ADMIN_BOOTSTRAP_USERNAME`/`ADMIN_BOOTSTRAP_PASSWORD`, `ADMIN_FORCE_LOCAL_LOGIN`, `LOG_LEVEL`.
- **Egress hardening (recommended):** container network policy limiting outbound traffic to the upstream hosts, ntfy/webhook targets, OIDC issuer, and plugin repo hosts (see §4.4 limit).

---

## 12. Security Summary

| Boundary                 | Control                                                                                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Internet → admin         | Separate port, not proxied publicly (deployment), plus login + TOTP/OIDC, sessions, CSRF, lockout                                                                                                                                                                                                |
| Internet → MCP endpoint  | Per-endpoint auth mode (§6.2), scoped tokens/grants, 403 outside scope, read-only ceiling by default                                                                                                                                                                                             |
| MCP client → upstream    | Sandbox (only the binding is reachable) → gate (§5.2) → plugin `invoke`                                                                                                                                                                                                                          |
| Model → config           | No MCP tool writes config; the sandbox has no DB access                                                                                                                                                                                                                                          |
| Plugin → core secrets/DB | Child process, permission model, scrubbed env, per-instance secrets only                                                                                                                                                                                                                         |
| Plugin supply chain      | Pinned versions, sha256, optional pinned-key signatures, unsigned warnings, prebuilt only (no install scripts)                                                                                                                                                                                   |
| Approval integrity       | Decided only on the approval page by a signed-in human with TOTP (fresh for locked), never by the calling client's own answer (form approvals opt-in, plain writes only); params-hash-bound, single-use, typed confirmation, in-memory params (restart ⇒ deny), access re-checked after approval |
| Secrets at rest          | AES-256-GCM, master key outside the DB, write-only APIs, redaction everywhere                                                                                                                                                                                                                    |
| Audit                    | Append-only, covers calls, searches, config, auth, plugin events; never exposed to the model                                                                                                                                                                                                     |

Residual risks, stated up front:

1. A malicious **installed** plugin can mislabel classifications or locked seeds for its own upstream, and can reach arbitrary network hosts. Mitigated by the trust flow (§4.3) and egress policy (§11), not by core.
2. `external` auth mode without JWT verification depends entirely on network placement.
3. SQLite single-writer: one core process. Scaling out would need Postgres. Out of scope.
4. Whether a call is a read or a write is decided once, before its approval wait. If a catalog sync turns a read that was put at its own `ask` into a write while its approval is open, the approved call still runs, without `prepareWrite` or the write budget. A human approved these exact params, and the window is the length of one approval.

---

## 13. Development Phases (TDD)

Tests first, phase gates, no loosening tests to pass. Coverage is tracked separately for the security-critical path: `pnpm --filter @synoikia/core test:coverage` (V8 coverage) fails when `gate/`, `auth/`, `approvals/`, `sandbox/` or `crypto/` drop below their thresholds in `packages/core/vitest.config.ts`.

| #     | Phase                                        | Tests first (highlights)                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | **Skeleton**                                 | Both listeners boot; `/healthz` on each; cross-port 404; SDK manifest schema validates a fixture manifest; admin login page renders                                                                                                                                                                                                                                                                                                 |
| 1     | **Plugin SDK contracts**                     | Manifest schema edge cases (unknown widget rejected, slug/ID patterns, `sdk` range); RPC message types round-trip; `runPlugin` dispatches, maps errors to codes                                                                                                                                                                                                                                                                     |
| 2     | **Classification & access levels (generic)** | `locked` > `override` > inferred; default-to-write; every branch of `effectiveAccess()` (level × read/write/locked × own level/group × acknowledgement × ceiling) incl. missing group; new groups at `ask`; new operations in an existing group get their own level; read→write reclassification resets acknowledgement; locked capped at Ask; migrations keep behaviour; aliases survive sync; a regroup never widens an operation |
| 3     | **DB, migrations, crypto**                   | AES-GCM round-trip; AAD binding (swapped rows fail); secrets never serialized by API DTOs; master-key bootstrap; rotation                                                                                                                                                                                                                                                                                                           |
| 4     | **Plugin host**                              | Spawn with permission flags (fs write denied, env scrubbed); IPC timeouts; crash → backoff restart; `PluginUnavailable` surfaced; disable → 503                                                                                                                                                                                                                                                                                     |
| 5     | **Plugin repos & install**                   | Index schema; sha256 mismatch rejected; signed repo: bad/missing signature rejected, key change blocks installs; unsigned requires confirm; a plugin installed elsewhere is never replaced; pre-configured repo added once                                                                                                                                                                                                          |
| 6     | **Catalog sync**                             | Diff upsert, stale marking, locked seed disables existing rules, refuse-serve with no prior sync, version-mismatch forced sync, debounce mutex                                                                                                                                                                                                                                                                                      |
| 7     | **Sandbox**                                  | Only bindings reachable; `require`/`process`/`fetch` absent; infinite loop killed; memory cap; errors catchable in-sandbox; approval wait excluded from wall clock                                                                                                                                                                                                                                                                  |
| 8     | **Gate & pre-approval**                      | Pipeline order; attestation before access check; `OperationDisabled` carries the access reason; target resolution fail-closed; match evaluator operators; all-targets rule; missing field ⇒ no match; rate limit ⇒ human fallback; expiry; locked never pre-approved                                                                                                                                                                |
| 9     | **Approval service**                         | A form-only client can never approve (unless opted in, plain writes only); URL prompt → approval page decides; decline ⇒ deny; completion notice sent; page needs TOTP (fresh for locked) + CSRF + literal; access re-checked after approval; params-hash single use; timeout ⇒ deny; restart ⇒ deny; no prompts ⇒ deny                                                                                                             |
| 10    | **Admin auth**                               | Setup only when empty; argon2 verify; TOTP + recovery; lockout; session idle/absolute expiry; CSRF; OIDC allow policy, link-only when auto-provision off; break-glass rules                                                                                                                                                                                                                                                         |
| 11    | **MCP auth**                                 | Each mode × scope matrix; 401 with RFC 9728 header; OAuth PKCE required; resource/audience binding; refresh rotation + reuse detection; DCR toggle; CF Access JWT verify                                                                                                                                                                                                                                                            |
| 12    | **Admin API**                                | Contract test per route; 409s; secret masking; config audit events with redacted diffs                                                                                                                                                                                                                                                                                                                                              |
| 13    | **Admin UI**                                 | Component tests per page (registry-picker behavior, typed-confirm approve, login/TOTP/OIDC flows)                                                                                                                                                                                                                                                                                                                                   |
| 14    | **MCP endpoints**                            | Per-slug routing; tool descriptions templated per plugin; `search` excludes disabled by default; `execute` end-to-end against a fake plugin + fake elicitation client                                                                                                                                                                                                                                                               |
| 15    | **Notifications**                            | ntfy JSON; webhook signature; retries; no approval events or links; stale stored event names dropped; no raw params in bodies                                                                                                                                                                                                                                                                                                       |
| 16    | **Maintenance jobs**                         | Mocked clock: debounce, cron stagger, mid-session recheck, housekeeping                                                                                                                                                                                                                                                                                                                                                             |
| 17–19 | **Plugins**                                  | Each plugin's own tests, in [synoikia-core-plugins](https://github.com/via-justa/synoikia-core-plugins): unit, the SDK conformance suite, and end to end on `@synoikia/core/testing` against a fake upstream                                                                                                                                                                                                                        |

**Progress** (updated as phases land):

| Phase                            | State | Where                                                                                                                                                                                                                                                   |
| -------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 Skeleton                       | done  | listeners, SPA shell, CI, Docker                                                                                                                                                                                                                        |
| 1 Plugin SDK contracts           | done  | `plugin-sdk`: manifest schema (incl. `showWhen`/`connection.help`), RPC types, `runPlugin`, **`checkConformance()`** for plugin test suites                                                                                                             |
| 2 Classification & access levels | done  | `core/src/gate/access.ts`, `core/src/catalog/groups.ts`: none/read/ask/write per group, per-operation level that wins, acknowledgement for Write, bulk preview/apply with typed slug, merge/rename with aliases; migration `0002`/`0003`                |
| 3 DB, migrations, crypto         | done  | `core/src/db`, `core/src/crypto` (AES-256-GCM + AAD, HKDF subkeys, key file bootstrap, `rotate.ts` + `cli.js rotate-master-key`)                                                                                                                        |
| 4 Plugin host                    | done  | `core/src/plugins`: discovery + registry upsert, `PluginProcess` (permission-confined fork, validated JSON-RPC, timeouts), `PluginSupervisor` (init, crash → backoff restart)                                                                           |
| 5 Plugin repos & install         | done  | `core/src/plugins/repos.ts`, `minisign.ts` (verified against the reference `minisign` tool, `ED` and legacy `Ed`): full-key pinning, key-change block, checksum, safe extraction, atomic swap; `default-repo.ts` pre-configures the Synoikia repository |
| 6 Catalog sync                   | done  | `core/src/catalog/sync.ts` + `instances/manager.ts`: session-start sync when stale, version check, `catalogChanged` debounce, per-instance mutex, daily backstop; `registry.ts` mirror for `registry.find`                                              |
| 7 Sandbox                        | done  | `core/src/sandbox`: fresh isolate per call, frozen bindings, JSON envelope, pausable budget, memory/result/log caps                                                                                                                                     |
| 8 Gate & pre-approval            | done  | `core/src/gate/pipeline.ts` (+ `match`, `redact`, `preapproval`, `attestation`, `rate-limit`), `core/src/runtime` (`executeCode`, `searchCode` with `catalog.*`, `registry.find`, `guides.get`)                                                         |
| 9 Approval service               | done  | `core/src/approvals/service.ts` + `http/mcp/approval-routes.ts`: URL-mode elicitation to the approval page (TOTP, CSRF, literal), opt-in form approvals for plain writes, timeout, orphan denial at startup                                             |
| 10 Admin auth                    | done  | `core/src/auth` (users, sessions, TOTP, throttle, OIDC) + `http/admin/auth.ts` (CSRF double-submit + Origin check)                                                                                                                                      |
| 11 MCP auth                      | done  | `core/src/auth/mcp-auth.ts`, `mcp-tokens.ts`, `oauth.ts` (OAuth 2.1 AS: DCR, PKCE, RFC 8707 resources, refresh rotation with reuse detection) + `http/mcp/oauth-routes.ts`                                                                              |
| 12 Admin API                     | done  | `core/src/http/admin/*`                                                                                                                                                                                                                                 |
| 13 Admin UI                      | done  | `packages/admin-ui`: every page in §8.2; component tests for login/TOTP/guards, Access (4 levels, Write dialog, stale list, bulk Write, per-operation levels), SchemaForm, endpoint settings; browser smoke test                                        |
| 14 MCP endpoints                 | done  | `core/src/http/mcp/endpoint.ts`: `search`/`execute` with tool annotations, sessions bound to endpoint + principal, URL/form prompt bridge; e2e with the real MCP SDK client                                                                             |
| 15 Notifications                 | done  | `core/src/notify`: ntfy (JSON publish) and signed webhooks, retries; informational events only                                                                                                                                                          |
| 16 Maintenance jobs              | done  | `core/src/maintenance.ts` (hourly housekeeping, optional audit retention) + daily repo index refresh                                                                                                                                                    |
| 17–19 Plugins                    | done  | TrueNAS, Seerr and Home Assistant in [synoikia-core-plugins](https://github.com/via-justa/synoikia-core-plugins), released as a signed plugin repository; `verifyPluginRepository` in `@synoikia/core/testing` checks each release                      |

Plugins are built and tested outside this repository, against the published `@synoikia/plugin-sdk` (with its **conformance test suite**) and `@synoikia/core/testing` (the **plugin harness**, which boots the real core on a plugin's bundle), so any third-party plugin can run the same checks.

---

## 14. Open Decisions

1. **Per-plugin network egress control** (§4.4). Options for a later iteration: route plugin egress through a core-owned HTTP proxy that enforces `network.hosts`, or run plugins in separate network namespaces. Not in v1.
2. **Audit retention default.** Currently "keep forever". Revisit if disk usage matters.
