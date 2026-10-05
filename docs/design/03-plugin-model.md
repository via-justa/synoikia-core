# §3 Plugin model

## 3.1 Responsibilities

Core makes every decision about what can reach an upstream. A plugin gives core the data for these decisions and makes the upstream call.

| Concern                                     | Core                               | Plugin                                                   |
| ------------------------------------------- | ---------------------------------- | -------------------------------------------------------- |
| MCP protocol, sessions, tool schemas        | Does it                            | —                                                        |
| Endpoint and admin authentication           | Does it                            | —                                                        |
| Sandbox and binding                         | Does it                            | Gives the binding names                                  |
| Access levels and locked operations         | Enforces them                      | Gives the group, the classification and the locked seeds |
| Pre-approval rules                          | Stores and evaluates them          | Gives the fields that rules can match                    |
| Approvals and typed confirmation            | Does them                          | Gives the summary text and the confirmation literal      |
| Audit log and redaction                     | Does them                          | Gives the sensitive keys, parameters and result fields   |
| Database, encryption, master key            | Owns them                          | Has no access                                            |
| Upstream connection and credentials         | Stores them encrypted              | Gets only its own decrypted secrets, and uses them       |
| Catalog discovery                           | Stores the catalog                 | Discovers it (introspection, OpenAPI, a declared list)   |
| Registry                                    | Stores it                          | Produces it                                              |
| Target resolution                           | Calls it                           | Does it                                                  |
| Configuration edits with optimistic locking | Shows the diff, keeps the hash     | Calculates the diff and the hash                         |
| Best-practice guides                        | Issues and checks attestation keys | Gives the guide text and version                         |
| Options for admin pickers                   | Shows them                         | Gives them (`optionsFor`)                                |

Core calls `invoke` only after the gate lets the call through. A plugin with errors, or a malicious plugin, can give core wrong inputs: a wrong classification, missing locks, a wrong summary. It cannot skip the gate. The admin accepts this risk when they install the plugin (§4.3).

## 3.2 Manifest

Each plugin has a `manifest.json`. The SDK (`@synoikia/plugin-sdk`) validates it with a zod schema. Example for a plugin `acme`:

```jsonc
{
  "id": "acme", // unique, [a-z0-9-]
  "name": "Acme Hub",
  "version": "1.0.0",
  "sdk": "^0.2.2", // plugin contract range (§3.3)
  "description": "Search/execute over the Acme Hub API.",
  "entry": "dist/index.js",
  "binding": {
    "namespace": "acme", // sandbox global: acme.*
    "functions": ["call"], // acme.call(...)
    "searchApis": ["registry"], // extra read-only APIs for search()
  },
  "labels": { "operation": "Operation", "operations": "Operations" },
  "capabilities": { "registry": true, "targets": true, "attestation": true, "configTransform": true },
  "connection": {
    "schema": {
      "type": "object",
      "required": ["baseUrl", "token"],
      "properties": {
        "baseUrl": { "type": "string", "format": "uri", "title": "Base URL" },
        "token": { "type": "string", "title": "API token", "writeOnly": true },
      },
    },
    "ui": { "token": { "widget": "secret", "help": "Settings → API tokens" } },
    "help": "Setup steps in Markdown.",
  },
  "sensitiveKeys": ["access_token", "webhook_id"],
  "network": { "hosts": ["{{connection.baseUrl}}"] },
  "targets": {
    "label": "Device",
    "registryKind": "device",
    "scopes": [
      { "key": "room", "label": "Room", "registryKind": "room" },
      { "key": "type", "label": "Device type" },
    ],
  },
  "matchProfiles": {
    "light": [
      {
        "field": "$targets",
        "label": "Targets",
        "widget": "registry-picker",
        "options": { "scopes": ["room"], "filter": { "type": "light" } },
        "covers": ["/target"],
      },
    ],
  },
}
```

- **Secrets.** A connection field with `writeOnly: true` is a secret. Core encrypts it and the API never returns it (§7.2). All other connection fields are plain configuration.
- **Network hosts.** `network.hosts` is a declaration. The admin reviews it before the plugin is enabled. Core does not enforce it (§4.4).
- **Targets.** A plugin with `capabilities.targets` declares `targets`. Core has no other knowledge of upstream objects.
  - `label` is the name of one target in the portal.
  - `registryKind` (optional) is the registry kind of the targets.
  - `scopes` are the dimensions that a rule can select targets by. Each scope has a lowercase `key`, a `label`, and optionally a `registryKind`.
  - Each target that `resolveTargets` returns gives its value for each scope in `scopes[key]`.
  - A `$targets` match field selects the scopes it offers (`options.scopes`) and can narrow suggestions (`options.filter`). The manifest is not valid if either names an undeclared scope.
- **Match profiles.** A match profile is a reusable set of fields that pre-approval rules can match (§5.2). An operation refers to one by name.

## 3.3 RPC contract

Core starts each instance as a child process with `child_process.fork`. Core and the child send JSON-RPC 2.0 messages over the IPC channel. Each request has a timeout of 30 s. `invoke` gets the time that remains in the sandbox budget. The SDK function `runPlugin(handlers)` is the child side. The core class `PluginProcess` is the parent side.

| Method                                                          | Required               | Purpose                                                                                              |
| --------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------- |
| `init({ instanceId, config, secrets, sdkVersion })`             | Yes                    | First call after start. This is the only time that secrets go to the child.                          |
| `testConnection()` → `{ ok, message?, upstreamVersion? }`       | Yes                    | "Test connection" on the Connection page. Core limits its rate.                                      |
| `getUpstreamVersion()` → `string`                               | Yes                    | A fast version check for version-triggered sync.                                                     |
| `syncCatalog()` → `{ upstreamVersion, sourceRef?, operations }` | Yes                    | The full catalog (`OperationDescriptor[]`).                                                          |
| `syncRegistry()` → `RegistryEntry[]`                            | With `registry`        | Upstream objects for pickers: `{ kind, id, name, parentId?, scopes?, attrs? }`.                      |
| `resolveOperation(fn, args)` → `{ key, params }`                | Yes                    | Maps a binding call to a catalog key. An unknown operation must throw.                               |
| `resolveTargets(key, params)` → `ResolvedTarget[]`              | With `targets`         | Expands the call to concrete targets. It must throw on an unknown target or scope value.             |
| `summarize(key, params, targets)` → `{ text, confirmLiteral? }` | Yes                    | The text for the approval. `confirmLiteral` is the text the approver types for a locked operation.   |
| `prepareWrite(key, params)` → `{ params, diff, expectedHash }`  | With `configTransform` | Applies a configuration change to the current object. Throws `ConfigConflict` if the object changed. |
| `invoke(key, params, context)` → `unknown`                      | Yes                    | The upstream call. Core calls it only after the gate.                                                |
| `optionsFor(source, query?)` → `{ value, label, meta? }[]`      | No                     | Options for admin pickers.                                                                           |
| `getGuide(key)` → `{ version, content }`                        | With `attestation`     | The best-practice guide of an operation.                                                             |
| `shutdown()`                                                    | Yes                    | Stops the child.                                                                                     |

The child can also send the notifications `log` and `catalogChanged`.

`InvokeContext` holds `callId` (unique for each call), `expectedHash` (from `prepareWrite`), `deadlineMs`, and `targets`. `targets` are the targets that the approver saw. The plugin acts on these targets. It does not resolve them again.

`OperationDescriptor`:

```ts
{
  key: string;                    // stable catalog key, unique for each instance
  displayName?: string;
  kind: string;                   // plugin-defined; `config` writes go through prepareWrite
  group: string;                  // access group (§5.2.1)
  groupLabel?: string;
  tag?: string;                   // for filters only
  classification: 'read' | 'write';
  classificationReason: string;   // for example 'verb:GET'
  locked?: boolean;
  typedConfirmation?: boolean;    // always true for a locked operation
  attestationRequired?: boolean;
  needsReview?: boolean;
  matchProfile?: string;
  paramsSchema?: JSONSchema;
  sensitiveParams?: string[];     // JSON pointers that core redacts (§5.5); 32 at most
  sensitiveResult?: 'whole' | { keys: string[]; deep?: boolean }; // result secrets that core masks (§5.5)
  docs?: { summary?: string; description?: string; guidance?: string };
}
```

Core validates all plugin output against the SDK schemas.

**Contract version.** `SDK_VERSION` in the SDK is the version of this contract. The current version is `0.2.2`. A manifest gives the range it accepts in `sdk`. Core does not load a plugin if its own contract version is outside that range.

- Core masks `sensitiveResult` from contract `0.2.2`. A plugin that declares `sensitiveResult` must require `^0.2.2` or later.
- `checkManifest`, `checkConformance`, `synoikia-plugin check` and `synoikia-plugin repo pack` refuse a plugin that does not.
- `init` gives the plugin the contract version of core. If it is lower than `0.2.2`, the SDK refuses `syncCatalog` when an operation declares `sensitiveResult`. It also refuses `invoke` of these operations.

## 3.4 Operation rules and split twins

A plugin built on the SDK declares its operation rules as data in `plugin.yaml`. The SDK rules engine (`compileRules`) applies the rules when the plugin builds its catalog. The build puts the file into the bundle. Core sees only the resulting descriptors. The file format is in [`plugin-authoring.md`](../plugin-authoring.md).

`plugin.yaml` declares:

- Locked operations and split twins.
- Classifications that replace the plugin heuristic.
- Match profiles, `sensitiveParams` and `sensitiveResult`.
- Confirmation literals, summary notes, descriptions and guidance.
- Operations to exclude from the catalog.
- Declared operations, for upstreams that core cannot discover.

The classification fails closed, in this order:

1. An excluded operation does not exist.
2. A locked operation, or a split twin, is a write with typed confirmation.
3. A classification from a rule.
4. The plugin heuristic, for example `GET` reads and other HTTP methods write.
5. If nothing gives a classification, the operation is a write.

**Split twins.** The risk of some operations depends on their parameters or targets. The plugin then gives the operation a second catalog key, `<key>#<suffix>`, which is always locked. `resolveOperation` selects the twin for each call. For example, `cover.open_cover#garage` is the key when a resolved target is a garage door. This keeps `locked` as a property of one catalog row, so core can enforce it.
