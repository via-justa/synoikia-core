# Writing a Synoikia plugin

A plugin connects one kind of self-hosted service (the _upstream_) to Synoikia. It describes the upstream's API: which operations exist, which read and which write, which are destructive, and which fields hold secrets. **It never decides what is allowed.** Core's sandbox, permission gate, approvals, redaction and audit apply to every call. Architecture: [`design/unified-mcp-server.md`](design/unified-mcp-server.md) §3–§5.

## Start

```sh
pnpm create @synoikia/plugin my-plugins        # a plugin repository, then its first plugin
cd my-plugins
pnpm new                                        # more plugins later (or: pnpm new --id x --archetype … --auth … --yes)
pnpm test                                       # check, build, unit and e2e tests of every plugin
```

`pnpm new` asks for an id, a name, an **archetype** and an **auth kind**:

| Archetype       | For                                                      | The catalog comes from                      |
| --------------- | -------------------------------------------------------- | ------------------------------------------- |
| `openapi-rest`  | REST APIs that serve an OpenAPI 3 spec                   | the spec (`buildOpenApiCatalog`)            |
| `static-rest`   | REST APIs without a spec                                 | `operations:` in `plugin.yaml`              |
| `websocket-rpc` | JSON-RPC 2.0 over WebSocket                              | `operations:` in `plugin.yaml`              |
| `blank`         | anything else: introspection endpoints, custom protocols | your code, decorated by `plugin.yaml` rules |

Auth kinds are `bearer`, `api-key` (with a header name), `basic` and `none`. The generated plugin builds and passes its tests straight away: unit tests for every archetype, plus end-to-end tests against a fake upstream in `test/` for all but `blank`.

## Files

| File            | What                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| `manifest.json` | Sandbox binding, connection form, `sensitiveKeys`, `network.hosts`, match profiles (SDK `ManifestSchema`) |
| `plugin.yaml`   | What the plugin tells core about its operations, as data (below)                                          |
| `src/plugin.ts` | `definePlugin(…)`: the client, the version, discovery, and decisions that need logic                      |
| `src/auth.ts`   | How each request authenticates                                                                            |
| `test/`         | A fake upstream, `checkConformance` unit tests, `checkPluginContract` e2e tests on core's harness         |

`synoikia-plugin build` bundles everything, `plugin.yaml` included (validated and inlined at build time), into one self-contained `dist/index.js`. At runtime the plugin runs as a permission-confined child: it can read nothing outside its package directory, and can't write files or spawn processes. **Network access is not restricted.** `network.hosts` is a declaration the admin reviews before enabling the plugin (an update that changes it arrives disabled again), not something core enforces; container egress policy is the mitigation (design §4.4, §14). List exactly the hosts the plugin connects to.

## `plugin.yaml`

Discovery lists operations; `plugin.yaml` decorates them by operation key. Editors validate it with the schema the SDK ships (`# yaml-language-server: $schema=./node_modules/@synoikia/plugin-sdk/plugin-settings.schema.json`).

```yaml
defaults:
  confirm: instance # typed-confirmation literal for locked operations without their own
  timeouts: { request: 15000, lookup: 10000 }
instanceName: { op: 'GET /status', field: name, fallback: Acme } # what `confirm: instance` types
exclude: ['POST /auth/*'] # left out of the catalog
include: [] # re-allows keys inside an excluded glob
operations: [] # declared operations (static-rest, websocket-rpc, blank)
rules:
  - match: 'DELETE /items/{itemId}' # a key, a list of keys, or globs: 'api_key.*', '*#garage'
    locked: true
    confirm: { lookup: { op: 'GET /items/{itemId}', args: [{ itemId: { $param: /path/itemId } }], field: name } }
  - match: 'POST /request/{id}/{status}'
    split: on-behalf # adds a locked twin 'POST /request/{id}/{status}#on-behalf'
  - match: '*#on-behalf'
    description: Approving a request filed by another user: locked.
    summaryNote: "(another user's request)"
  - match: pool.dataset.create
    matchProfile: dataset-name-prefix
    sensitiveParams: [/0/encryption_options/key]
    guidance: Name is "<pool>/<path>".
  - match: auth.generate_token
    sensitiveResult: whole # or { keys: [key], deep: true }
  - match: 'GET /sync/status'
    classification: read # a reviewed override of the heuristic
    reason: reviewed:read
    needsReview: false
plugin: {} # anything specific to this upstream, validated by the plugin's own schema
```

### Rule fields

| Field             | Effect                                                                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `locked`          | Always write, always a human who types the confirmation literal. Any matching rule locks.                                                                                          |
| `classification`  | Overrides the plugin's heuristic (`read` or `write`), with `reason` and `needsReview`. Never unlocks.                                                                              |
| `split`           | Adds a locked twin `<key>#<suffix>`; the plugin decides per call when the twin applies (`splitWhen`).                                                                              |
| `confirm`         | Literal source(s), first that yields wins: `instance`, `targets`, `{ param: /pointer }`, `{ lookup: … }`, `{ custom: name }`. A lookup falls back to the `$param` it looked up by. |
| `sensitiveParams` | JSON pointers core redacts from params wherever they are shown or stored (all matching rules add up).                                                                              |
| `sensitiveResult` | Secrets in the result that core can't recognize by key name: `whole`, or `{ keys, deep }`. Core masks them (below). Needs `sdk` `^0.2.2` or later in the manifest.                 |
| `matchProfile`    | The manifest match profile pre-approval rules use for this operation.                                                                                                              |
| `summaryNote`     | Appended to the approval summary.                                                                                                                                                  |
| `description`     | `docs.description` (`{base}` and `{key}` are replaced).                                                                                                                            |
| `guidance`        | `docs.guidance` shown to the model.                                                                                                                                                |
| `attestation`     | Requires the model to read a guide first (`getGuide`).                                                                                                                             |

A field set by several matching rules takes the **first** rule's value, except `locked` and `attestation` (any rule) and `sensitiveParams` and `summaryNote` (all rules). `sensitiveParams`, `sensitiveResult`, `matchProfile` and `guidance` also apply to a split twin through its base key.

### Precedence, which fails closed

1. `exclude` (unless `include`d): the operation doesn't exist.
2. `locked`, or being a split twin: write, typed confirmation.
3. A rule's `classification`.
4. The plugin's own heuristic (an OpenAPI GET reads, other verbs write, and a GET whose description or path names an action, such as `/cache/flush`, is a write flagged for review).
5. Nothing settled it: write.

### What the SDK refuses

- An OpenAPI spec with two templates a concrete path can't tell apart (`/user/{id}` and `/user/{userId}/`): rules match keys by text, so a lookalike key could route around a lock.
- Path parameters that are `.`, `..` or not a plain string or number, and request paths with dot segments: the endpoint core gated is the one called.
- More than 32 `sensitiveParams` on one operation (core's limit), rather than silently redacting fewer.
- A spec whose `$ref`s expand past a fixed budget, and YAML aliases past 100.

`sensitiveResult` masks any non-empty value under a listed key (strings, numbers, objects), and anything nested deeper than it looks. Like `sensitiveParams`, it travels on the operation descriptor and **core** applies it, to the plugin's raw result right after `invoke` and before its own redaction by key name and secret value: an `invoke` returns the upstream's result as is. Core does this from plugin contract `0.2.2`, so a plugin with a `sensitiveResult` rule must declare `"sdk": "^0.2.2"` (or later) in its manifest, or an older core would drop the field; `synoikia-plugin check`, `checkConformance` and `repo pack` refuse it otherwise, and on an older core the SDK itself refuses to sync and to run any operation that declares one. The one thing core can't attribute is another operation's result handed back inside this one's (a job queue's records): mask those with `rules.maskEmbeddedResult(key, value)`, which applies `key`'s rule.

## The SDK

| Need                                   | Use                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Lifecycle (init, close, version, test) | `definePlugin({ connect, close, version, probe, handlers(kit) })`, `kit.lazy()` caches                 |
| HTTP upstream                          | `HttpJsonClient` (TLS verify toggle, no redirects, size cap, re-auth retry), `restLookup`              |
| Socket protocol                        | `PendingRequests`, `singleFlight`, `joinApiPath(…, { websocket: true })`                               |
| OpenAPI catalog and binding            | `buildOpenApiCatalog`, `restBinding`, `fetchSpec`                                                      |
| Declared catalog                       | `staticCatalog`, `staticHttpBinding`                                                                   |
| Rules                                  | `parsePluginSettings`, `compileRules` (`describe`, `confirmLiteral`, `maskEmbeddedResult`, …)          |
| Errors                                 | `PluginError`, `upstreamError`, `statusKind`                                                           |
| Tests                                  | `checkConformance`, `checkManifest`; `startFakeHttp`, `checkPluginContract` (`@synoikia/core/testing`) |

## Rules every plugin keeps

- Every credential connection field is `writeOnly`, uses the `secret` widget and is in `sensitiveKeys`; so is every secret field the upstream returns (or it gets a `sensitiveResult` rule). `synoikia-plugin check` enforces the first part, and the e2e `secrets` contract check the second.
- Model-supplied arguments never change the host, scheme or port, never set auth headers, and path parameters are encoded. The operation core gated is the one invoked.
- Approval summaries and confirmation literals show exactly what is affected, and never secrets.
- No plugin-side allow/deny lists, approval prompts or secret handling: that is core's job. If a plugin needs something core doesn't offer, change core first.

## Releasing

A repository created with `--release` publishes a signed plugin repository: bump a plugin's version in `manifest.json` and `package.json` and merge. See its `RELEASING.md`; the workflow runs `synoikia-plugin repo pack | index | verify | publish`, signing between `pack` and `index`.
