# §2 Topology

```
                Internet / LAN                                LAN only
          mcp.example.com (TLS at proxy)              admin.lan (TLS at proxy, optional)
                       │                                         │
┌──────────────────────┼─────────────────────────────────────────┼─────────────────┐
│ Container            ▼                                         ▼                 │
│  ┌───────────────────────────────────────┐   ┌────────────────────────────────┐ │
│  │ MCP listener :8080                    │   │ Admin listener :8081           │ │
│  │  /{slug}          MCP endpoint        │   │  /         Vue SPA             │ │
│  │  /.well-known/oauth-*                 │   │  /api/*    Admin API           │ │
│  │  /oauth/*         OAuth server, pages │   │  /auth/*   sign-in, OIDC       │ │
│  │  /a/{token}       approval page       │   │  /healthz                      │ │
│  │  /healthz                             │   └───────────────┬────────────────┘ │
│  └───────────────┬───────────────────────┘                   │                  │
│                  │ endpoint auth (§6.2)                      │ session (§6.1)   │
│                  ▼                                           ▼                  │
│  ┌──────────────────────────── core process ─────────────────────────────────┐ │
│  │  Endpoints: one MCP server per instance (search, execute)                 │ │
│  │  Sandbox ── binding ──▶ Gate (§5) ──▶ Approval service (§5.3)              │ │
│  │  Plugin host (§4) ── IPC JSON-RPC ──┬──────────┬──────────┐                │ │
│  │  Scheduler (§10)   SQLite + crypto  │          │          │                │ │
│  └─────────────────────────────────────┼──────────┼──────────┼────────────────┘ │
│                                        ▼          ▼          ▼                  │
│                                   instance A  instance B  instance C  (children) │
└────────────────────────────────────────┼──────────┼──────────┼──────────────────┘
                                         ▼          ▼          ▼
                                     upstream A  upstream B  upstream C
```

## 2.1 Listener separation

The two listeners are two separate Hono apps on two ports. A route of one listener does not exist on the other. For example, `GET :8080/api/instances` and `GET :8081/{slug}` both return 404.

| Listener | Default        | Variables                  | Serves                                                                                               |
| -------- | -------------- | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| MCP      | `0.0.0.0:8080` | `MCP_HOST`, `MCP_PORT`     | MCP endpoints, OAuth server and metadata, OAuth sign-in and consent pages, approval page, `/healthz` |
| Admin    | `0.0.0.0:8081` | `ADMIN_HOST`, `ADMIN_PORT` | Admin SPA, Admin API, admin sign-in, OIDC callback, `/healthz`                                       |

`PUBLIC_MCP_URL` is the public address of the MCP listener, for example `https://mcp.example.com`.

- OAuth needs it. It is the issuer and the resource base in OAuth metadata.
- Approval-page links start with it.
- If it is not set, OAuth is off. OAuth routes and metadata return 503. Core does not accept OAuth tokens. The Overview page shows a warning. Bearer tokens continue to work.
- Core never takes the issuer from the `Host` header of a request, because the client controls it. Only the approval-page link, which goes back to the same client, uses the request origin when `PUBLIC_MCP_URL` is not set.

`PUBLIC_ADMIN_URL` is optional. Core uses it for OIDC redirect URIs and for links in notifications.

The MCP listener shows a small fixed set of HTML pages: OAuth sign-in, OAuth consent, and the approval page. These pages use the portal user accounts and the OIDC configuration. Each purpose has its own cookie:

| Purpose  | Cookie            | Path     | Session kind  |
| -------- | ----------------- | -------- | ------------- |
| Consent  | `syn_mcp_oauth`   | `/oauth` | `oauth_ui`    |
| Approval | `syn_mcp_approve` | `/a`     | `approval_ui` |

These sessions are short. The Admin API does not accept them. A consent session cannot decide approvals. An approval session cannot authorize clients.

## 2.2 Endpoint routing

- `/{slug}` is the Streamable HTTP endpoint of one instance. `POST` sends JSON-RPC. `GET` opens the SSE stream. `DELETE` ends the session.
- A slug matches `^[a-z0-9][a-z0-9-]{0,62}$` and is unique. These words are reserved: `oauth`, `a`, `healthz`, `.well-known`, `api`, `auth`, `static`.
- **DNS-rebinding defence.** The `Host` header must be the host of `PUBLIC_MCP_URL`, a name in `MCP_ALLOWED_HOSTS`, `localhost`, or an IP address. Otherwise core returns 403. A browser `Origin` must be in the same set.
- Authentication comes first (§6.2). Then:
  - An unknown slug returns 404.
  - A disabled instance, or an instance of a disabled plugin, returns 503 with a JSON-RPC error.
- Each instance has its own `McpServer` with `search` and `execute`. The tool descriptions come from the plugin manifest. For example, the model sees `acme.call(...)` on an endpoint of the plugin `acme`.
- Core keys MCP sessions by instance and `Mcp-Session-Id`. A session records the principal (§6.2) and whether the client supports elicitation.
- A principal can have 16 open MCP sessions. A new session closes the least recently used one.
