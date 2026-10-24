# Synoikia reference

Facts about Synoikia core that are not a decision or a behavior. The decisions are ADRs in [`adrs/`](adrs/). The behavior is the feature files in [`features/`](../features/). The structure is the LikeC4 model in [`architecture/`](architecture/README.md).

## Glossary

Each term has one meaning. Documents, ADRs, feature files and the model use these words.

| Term                | Meaning                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Core                | The Synoikia server process. It owns all security decisions.                                                      |
| Upstream            | A self-hosted service that a plugin connects to.                                                                  |
| Plugin              | A package that describes one kind of upstream API to core. It makes no security decisions.                        |
| Instance            | One configured connection of a plugin to one upstream. It runs as one child process.                              |
| Endpoint            | The MCP endpoint of one instance, at `/{slug}`.                                                                   |
| Operation           | One upstream call that the catalog lists, with a stable key.                                                      |
| Catalog             | The list of operations of one instance, synced from the plugin.                                                   |
| Group               | A set of operations that share an access level, for example one API tag.                                          |
| Access level        | `none`, `read`, `ask` or `write`. It controls if an operation runs, asks, or is off.                              |
| Locked operation    | An operation that always needs a human approval with a typed confirmation. A typed confirmation also locks it.    |
| Split twin          | A second, locked key for an operation, used when its risk depends on its parameters.                              |
| Principal           | The authenticated identity that calls an endpoint. Each principal belongs to one user.                            |
| Role                | What a user can reach: the built-in Admin role, or a role that an admin makes.                                    |
| Role maximum        | The highest access level that a role allows for a group or an operation.                                          |
| Personal level      | An access level that a user sets for their own calls, at most the role maximum.                                   |
| Self-registration   | The creation of a user without an admin, with the default role.                                                   |
| Access ceiling      | The most that a principal can do: `read` or `write`.                                                              |
| Client auth method  | How an MCP client proves who it is: `bearer`, `oauth` or `external`.                                              |
| Client name         | The `clientInfo.name` that an MCP client declares in `initialize`. It is not authentication.                      |
| External provider   | A service in front of the MCP listener that identifies the user of a request.                                     |
| Approval            | A human decision on one call, made on the approval page or in the agent session.                                  |
| In-session approval | An approval in the agent session: a form prompt or the approval card. Set with `formElicitationApprovals: 'ask'`. |
| Parked execution    | An `execute` that waits on the server for an approval after its tool call answered.                               |
| Approval card       | The MCP Apps view that shows a parked approval in the chat. It approves only in session.                          |
| Session grant       | A time-limited permission, given on the approval page, that auto-approves `ask` for a client.                     |
| Pre-approval rule   | A stored rule that approves matching calls without a human.                                                       |
| Target              | A concrete upstream object that a call acts on, for example one device.                                           |
| Registry            | The local copy of the upstream objects that a plugin lists, for pickers and target selection.                     |
| Binding             | The function in the sandbox that sends a call to the gate, for example `acme.call(...)`.                          |
| Gate                | The permission pipeline between the binding and the plugin.                                                       |
| Sandbox             | The `isolated-vm` isolate that runs model code.                                                                   |
| Attestation key     | A key that shows that the model read a best-practice guide in the same MCP session.                               |
| Redaction           | The replacement of secret values with `[REDACTED]`.                                                               |
| Audit log           | The append-only log of calls, searches, configuration changes, sign-ins and plugin events.                        |
| Bundle              | The built plugin code (`dist/index.js`) with its `manifest.json`.                                                 |

## Limits

- Each user has one role. Only the Admin role administers the server. The other roles are made by an admin and only limit access.
- There is one core process. It owns the SQLite file. The design does not scale across hosts.
- Core does not terminate TLS. A reverse proxy does this.
- There is no endpoint that combines the tools of many instances. Each instance is its own MCP server.

## Search APIs

In `search(code)`, the sandbox (ADR-0005) has these read-only APIs:

- `catalog.find({ text?, group?, tag?, kind?, classification?, includeDisabled? })` returns descriptors. By default it returns only callable operations (ADR-0004).
- Each descriptor has `approval: 'none' | 'required' | 'auto'`: it runs, it asks a human, or it runs without a question. With `includeDisabled`, the other operations come back marked `disabled` with a `reason`.
- `catalog.groups()` returns the groups with their levels and counts. The model can then tell the user why an operation is not callable.
- `catalog.get(key)` returns the full descriptor with `paramsSchema` and docs.
- `registry.find({ kind?, text?, parent?, scopes? })` returns matching registry entries only, never the full registry. It exists only if the plugin has `registry`.
- `guides.get(key)` returns the guide of an operation with its `best_practice_key` (ADR-0003). It exists only if the plugin has `attestation`.

The `catalog` and `registry` APIs read only the database. `guides.get` calls the plugin once for each read (`getGuide`). Core stores a new `guides` row when the guide version or content changed. Core audits each run as a `search` event.

## Binding errors

Core throws these errors into the sandbox as `Error` objects with a `code` property (ADR-0003).

| Code                       | Cause                                                                                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNKNOWN_OPERATION`        | The plugin cannot map the call to a catalog key.                                                                                                                                                |
| `ATTESTATION_REQUIRED`     | The call has no valid attestation key.                                                                                                                                                          |
| `OPERATION_DISABLED`       | Level `none` (also a write in a group at `read`), a read-only principal, a locked operation without its own `ask`, or a level change while the approval was open. The message gives the reason. |
| `TARGET_RESOLUTION_FAILED` | The plugin cannot resolve a target.                                                                                                                                                             |
| `TARGETS_CHANGED`          | The targets are not the targets that the approver saw. The call must be made again.                                                                                                             |
| `OPERATION_CHANGED`        | The operation is not the operation that the approver saw (ADR-0006). The call must be made again.                                                                                               |
| `CONFIG_CONFLICT`          | The object changed after it was read (`prepareWrite`).                                                                                                                                          |
| `INVALID_PARAMS`           | The plugin refused the parameters of the call.                                                                                                                                                  |
| `PERMISSION_DENIED`        | A human denied the call, the client declined, the approval timed out or was cancelled, the client cannot show an approval and cannot park, or the client has too many parked executions.        |
| `RATE_LIMITED`             | The principal used its write budget.                                                                                                                                                            |
| `UPSTREAM_DENIED`          | The upstream refused the call for lack of permission.                                                                                                                                           |
| `UPSTREAM_ERROR`           | The upstream call failed.                                                                                                                                                                       |
| `UPSTREAM_TIMEOUT`         | `invoke` did not answer before its deadline, or the child of a write stopped during it. The result is unknown.                                                                                  |
| `PLUGIN_UNAVAILABLE`       | The plugin child is down, stopped sending heartbeats (ADR-0023), or the bundle changed while the call waited.                                                                                   |
| `PLUGIN_ERROR`             | The plugin answer is not valid, or the plugin gave an error code that core does not pass on.                                                                                                    |
| `EXECUTION_ENDED`          | The `execute` run ended before the call, or core stopped its parked execution.                                                                                                                  |
| `NOT_A_BINDING`            | The sandbox asked the host for a function that is not a binding.                                                                                                                                |
| `INTERNAL`                 | An unexpected error in core. The message gives no detail.                                                                                                                                       |

## Run results

The tool result of `execute`, `search` or `resume` carries these codes. A binding error that the code does not catch ends the run with its own code.

| Code                  | Cause                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `RATE_LIMITED`        | The principal used its run budget. Core makes no isolate.                                                        |
| `BUSY`                | Too many sandboxes run, or another `resume` waits on the same execution.                                         |
| `SYNTAX_ERROR`        | The code does not compile.                                                                                       |
| `CODE_ERROR`          | The code threw an error without a string `code`.                                                                 |
| `TIMEOUT`             | The run passed its time limit (ADR-0005).                                                                        |
| `MEMORY_LIMIT`        | The run passed its memory limit (ADR-0005).                                                                      |
| `INTERNAL`            | An unexpected error in core.                                                                                     |
| `AWAITING_APPROVAL`   | The execution parked on an approval (ADR-0006). The tool result is not an error.                                 |
| `STILL_RUNNING`       | `resume`: the script still runs after the decision.                                                              |
| `EXECUTION_NOT_FOUND` | `resume`: the id is unknown or collected, belongs to another principal or endpoint, or is from before a restart. |

## MCP client policy

The client policy allows or denies MCP clients by their client name: the `clientInfo.name` of the MCP `initialize` request. The admin sets it under Settings → Client auth (`mcp.clientPolicy`). It is not a security boundary (ADR-0002).

| `mode`          | Core refuses                                                     |
| --------------- | ---------------------------------------------------------------- |
| `off` (default) | No client                                                        |
| `allow`         | A client whose name is not in `names`, and a client with no name |
| `deny`          | A client whose name is in `names`                                |

- `names` holds at most 50 names of 1 to 100 characters. Core trims each name and removes duplicates. The match is exact, without regard to case.
- Core refuses a save of `allow` mode with no names, with 400 `invalid_settings`.
- Core checks the policy after authentication (ADR-0009), on an `initialize` request, before it makes the MCP session. It reads the body once, with the limits of the MCP transport.
- Core checks the policy again on each later request of a session. A policy change thus ends an open session of a refused client at its next request.
- A refusal gets 403 with the JSON-RPC error `-32003` "This MCP client is not allowed on this server", and no session. Core logs it in the server log and audits `client_refused`.
- Core keeps in memory the last 50 client names that opened an MCP session, for the admin to add to the policy. A restart clears the list.

The feature file `@id:client-policy` specifies its behavior.

## Plugin manifest

An example `manifest.json` for a plugin `acme`. The SDK validates it with a zod schema (ADR-0011).

```jsonc
{
  "id": "acme", // unique, [a-z0-9-]
  "name": "Acme Hub",
  "version": "1.0.0",
  "sdk": "^0.3.0", // plugin contract range (ADR-0011)
  "description": "Search/execute over the Acme Hub API.",
  "entry": "dist/index.js",
  "instructions": "instructions.md", // optional agent instructions (Markdown)
  "lifecycle": "on-demand", // optional: core may stop the child of an idle instance (ADR-0022); default "always"
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

## Plugin repository index

An example `index.json` of a plugin repository (ADR-0013). `signature` is required in a signed repository.

```jsonc
{
  "schema": 1,
  "name": "Example community plugins",
  "homepage": "https://github.com/example/mcp-plugins",
  "publicKey": "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3", // optional, minisign
  "plugins": [
    {
      "id": "unifi",
      "name": "UniFi Network",
      "description": "Search/execute over the UniFi controller API",
      "versions": [
        {
          "version": "0.3.1",
          "sdk": "^0.2.0",
          "minCoreVersion": "1.0.0",
          "url": "https://github.com/example/mcp-plugins/releases/download/unifi-0.3.1/unifi-0.3.1.tgz",
          "sha256": "9f2c…",
          "signature": "untrusted comment: …\nRWQ…", // required in a signed repository
        },
      ],
    },
  ],
}
```

## Topology

The model views `containers` and `deployment` in [`architecture/`](architecture/README.md) show the container, the two listeners, the core process, the plugin children and the upstreams. ADR-0015 describes the listeners.

## Data

Core keeps all data in one SQLite file, `DATA_DIR/synoikia.sqlite` (default `/data`). It opens the file with better-sqlite3 in WAL mode. The schema is in `packages/core/src/db/schema.ts`. Drizzle generates the migrations in `packages/core/drizzle/`, and core applies them at start. JSON values are stored as `TEXT`. Timestamps are epoch milliseconds.

Core keeps credentials, users, levels, catalogs and instances in memory, and reads them again after core writes their tables (ADR-0021). Core does not see a change that another process makes to the file, such as the `sqlite3` shell or `rotate-master-key --force` while core runs. Restart core after such a change.

### Tables

**Identity and admin authentication**

| Table         | Holds                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`       | `username` (unique), `kind` (`local` or `sso`, ADR-0025), `oidc_email` (the address an SSO account waits for, unique without case), `password_hash`, `totp_secret_enc`, `totp_enabled`, `totp_last_step`, `recovery_codes_hash`, `oidc_issuer`, `oidc_subject`, `last_login_at`, `disabled`, `role_id`, `registered_via` (`oidc`, `external`, `signup`, or NULL when an admin made the user) |
| `roles`       | `name` (unique), `built_in` (the Admin role, id `admin`), `can_see_other_endpoints`                                                                                                                                                                                                                                                                                                          |
| `sessions`    | `id_hash` (key), `user_id`, `kind` (`admin`, `oauth_ui`, `approval_ui`), `last_seen_at`, `expires_at`, `ip`, `user_agent`                                                                                                                                                                                                                                                                    |
| `settings`    | `key`, `value` (JSON): authentication defaults, rate limits, flags                                                                                                                                                                                                                                                                                                                           |
| `oidc_config` | One row: `issuer`, `client_id`, `client_secret_enc`, `scopes`, `allow_policy`, `auto_provision`, `enabled`                                                                                                                                                                                                                                                                                   |

**Plugins**

| Table              | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin_repos`     | `url` (unique), `name`, `signing_mode` (`signed`, `unsigned`), `public_key`, `key_fingerprint`, `key_status` (`ok`, `key_changed`), `index_cache`, `last_fetched_at`, `last_fetch_error`                                                                                                                                                                                                                                                       |
| `plugins`          | `plugin_id` (unique: one installed version for each id), `version`, `repo_id`, `path`, `sha256`, `signature_verified`, `manifest`, `status` (`ok`, `invalid`, `incompatible`), `status_error`, `instructions` (text of the instructions file, ADR-0011), `enabled`, `manual` (uploaded build, ADR-0013)                                                                                                                                        |
| `plugin_instances` | `plugin_id`, `slug` (unique), `display_name`, `enabled`, `config`, `secrets_enc`, `auth_methods` (JSON list of client auth methods, or NULL for all enabled methods), `settings` (approval timeout, rate limits, sandbox limits, idle stop), `status` (`stopped`, `starting`, `ready`, `error`, `idle`), `status_error`, `upstream_version`, `source_ref`, `last_synced_at`, `last_sync_status`, `catalog_plugin_version` (Maintenance, below) |

**Catalog** (for each instance)

| Table                     | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operation_groups`        | `instance_id`, `key`, `label`, `level` (`none`, `read`, `ask`, `write`), `level_changed_at`, `level_changed_by`, `first_seen_at`, `stale`                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `operation_group_aliases` | `instance_id`, `plugin_group`, `group_key`: the merges of the admin                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `operations`              | `instance_id`, `key`, `display_name`, `kind`, `tag`, `classification` (`read`, `write`: locked means write), `classification_source` (`locked`, `inferred`), `inferred_classification`, `inferred_reason`, `plugin_group`, `group_id`, `locked`, `level_override` (NULL: follows the group), `write_acknowledged`, `acknowledged_at`, `acknowledged_by`, `typed_confirmation`, `attestation_required`, `attestation_waived`, `needs_review`, `match_profile`, `params_schema`, `sensitive_params`, `sensitive_result`, `docs`, `first_seen_at`, `last_seen_at`, `stale` |
| `registry_entries`        | `instance_id`, `kind`, `ext_id`, `name`, `parent_ext_id`, `scopes`, `attrs`, `stale`, `last_synced_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `guides`                  | `instance_id`, `operation_id`, `version`, `content`, `fetched_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Gate**

| Table                | Holds                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pre_approval_rules` | `instance_id`, `operation_id`, `match`, `rate_limit`, `window_seconds`, `expires_at`, `reason` (required), `enabled`, `created_by`, `owner_user_id` (NULL: an admin rule), `updated_at`, `last_triggered_at`, `strict_miss_at`                                                                                                |
| `pre_approval_hits`  | `rule_id`, `occurred_at`                                                                                                                                                                                                                                                                                                      |
| `pending_approvals`  | `instance_id`, `operation_id`, `params_display` (redacted), `params_hash`, `resolved_targets`, `summary`, `confirm_literal`, `diff`, `expected_hash`, `client_kind`, `client_id`, `mcp_session_id`, `requested_at`, `expires_at`, `status`, `decided_by`, `decided_via` (`elicitation`, `url`), `decided_at`, `owner_user_id` |
| `approval_links`     | `token_hash` (key), `approval_id`, `action`, `expires_at`, `used_at`                                                                                                                                                                                                                                                          |
| `audit_log`          | `at`, `kind` (`call`, `search`, `config`, `auth`, `plugin`), `instance_id`, `operation_key`, `classification`, `decision`, `actor_kind` (`mcp_client`, `user`, `system`), `actor_id`, `decided_by`, `decided_via`, `params` (redacted), `resolved_targets`, `result_status`, `duration_ms`, `detail`                          |

The `decision` of a call is one of: `auto-executed`, `auto-approved:level`, `auto-approved:rule:<id>`, `human-approved`, `denied`, `timed-out`, `rejected:<reason>`, `error:<code>`.

The `auth` event `user_deleted` keeps the `user_id`, `username` and `registered_via` of a deleted user in `detail` (ADR-0008). The audit log reads take the user name from it for the events of that user, with `actorDeleted` true. The CSV export has the same column.

**Roles** (ADR-0010)

| Table            | Holds                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `role_instances` | `role_id`, `instance_id`: the endpoints of a role, with `can_set_own_levels`, `can_manage_own_rules`, `can_see_status` |
| `role_levels`    | `role_id`, `instance_id`, `group_id` or `operation_id`, `level`, `changed_at`, `changed_by`: role maximums             |
| `user_levels`    | `user_id`, `instance_id`, `group_id` or `operation_id`, `level`, `changed_at`: own levels                              |

**MCP client authentication**

| Table           | Holds                                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `mcp_tokens`    | `name`, `token_hash` (unique), `scope`, `access` (`read`, `write`), `created_by`, `expires_at`, `last_used_at`, `revoked_at` |
| `oauth_clients` | `client_id` (unique), `client_secret_hash`, `name`, `redirect_uris`, `registered_via` (`dcr`, `admin`), `revoked_at`         |
| `oauth_grants`  | `client_id`, `user_id`, `resources`, `instance_ids`, `access`, `revoked_at`                                                  |
| `oauth_codes`   | `code_hash` (key), `grant_id`, `code_challenge`, `redirect_uri`, `resources`, `expires_at`, `used_at`                        |
| `oauth_tokens`  | `token_hash` (key), `grant_id`, `kind` (`access`, `refresh`), `family_id`, `resources`, `expires_at`, `revoked_at`           |

**Notifications**

| Table               | Holds                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `notifier_channels` | `kind` (`ntfy`, `webhook`), `name`, `config`, `secrets_enc`, `events`, `instance_filter`, `enabled`, `last_sent_at`, `last_error` |

### Stored JSON from an older release

Core reads stored JSON settings (global and for each instance) in a lenient mode. If the current schema refuses a field, core uses its default and logs a warning. At start, core removes the refused fields from the stored JSON once. It keeps valid fields as they are, so new defaults apply to fields that nobody set. Discovery validates plugin manifests again at each start. Core marks a plugin with a manifest that is no longer valid as unusable, and its endpoints return 503.

Feature files: `@id:stored-settings-upgrade`, `@id:upgrades`.

## Admin portal

The admin portal is a Vue 3 single-page app (Vite, vue-router). The Admin listener serves it as static files. Its visual style uses the Synoikia brand, in a light and a dark theme. Terracotta marks the one primary action of a page. The fonts are Fraunces for the word mark and IBM Plex Sans and Mono for all other text.

| Concern       | Design                                                                                                                                                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server data   | `@tanstack/vue-query`. Pages read and change Admin API data through shared composables. A sign-out or a change of user clears the cached data.                                                                                                                                               |
| Client state  | Two Pinia setup stores: the sign-in session, and the `/api/events` stream. An event makes the queries of its data stale.                                                                                                                                                                     |
| Confirmations | `ModalDialog`, also through the shared confirm and prompt dialog. The portal does not use the native browser dialogs.                                                                                                                                                                        |
| Accessibility | A skip link to the page content. On a route change, the portal moves focus to the content, sets the page title and announces it. One polite live region announces short messages, for example "Copied". The arrow keys, Home and End operate tabs and radio groups.                          |
| Help          | Each signed-in page has a help topic, one Markdown file in `packages/admin-ui/src/help`. The icon in the page header and the ? key open it in a drawer. The drawer searches the topics that the role may read. A page keeps only what the person acts on. The explanation goes in its topic. |

### Navigation

```
┌ Sidebar ──────────────────┐
│ Synoikia                  │
│ Overview                  │  all endpoints
│ ENDPOINTS                 │
│ ▾ /acme      ● Ready      │  open when selected
│     Connection            │
│     Access                │  access levels (ADR-0004)
│     Pre-Approval Rules    │
│     Settings              │
│ ▸ /other     ● Error      │
│ + New endpoint            │
│ Plugins                   │
│ Clients & Tokens          │
│ Settings                  │
│ Audit Log                 │  all instances
│ ───────────────────────── │
│ My profile                │
│ admin · Sign out          │
└───────────────────────────┘
```

The sidebar above is the one of an admin. A user with another role (ADR-0010) sees only "My endpoints", the endpoints of the role, and "My profile". "My profile" and the user name in the sidebar footer open `/profile` for every role. The portal sends a user with another role from an admin page, and from all Settings tabs, to "My endpoints". The Admin API refuses the admin routes anyway (Admin API, below).

### Pages

Each page reads and changes data only through the Admin API (Admin API, below). The Admin API decides who can do what. The portal only hides what a role cannot use.

| Page                   | Content                                                                                                                                                         | Feature files                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Sign in**            | Password, the TOTP step, OIDC, lockout messages, and the sign-up form while it is on (ADR-0010).                                                                | `@id:sign-in`                                                 |
| **Setup**              | Only while there are no users: the first admin.                                                                                                                 | `@id:sign-in`                                                 |
| **My endpoints**       | For every user: the endpoints of the role, their operations and the level in force. Personal levels and own rules as the switches allow (ADR-0010).             | `@id:portal-my-instances`                                     |
| **Overview**           | Admin only. A card for each instance, plugin child and notifier health, and how to connect a client.                                                            | `@id:portal-shell`                                            |
| **New endpoint**       | Plugin, slug, display name, client auth methods, in-session approval (ADR-0006), and the connection form (ADR-0018).                                            | `@id:portal-instances`                                        |
| **Connection**         | The connection form (ADR-0018), Test connection, the status and the last sync.                                                                                  | `@id:portal-instances`                                        |
| **Access**             | The levels of the endpoint (ADR-0004), or the role maximums of another role.                                                                                    | `@id:portal-instances`, `@id:portal-roles`                    |
| **Pre-Approval Rules** | The rules of the endpoint (ADR-0003). Locked operations are not in the picker.                                                                                  | `@id:portal-instances`                                        |
| **Endpoint Settings**  | The settings of the instance: client auth methods, approvals, session grants (ADR-0006), limits, extra redaction keys, and delete.                              | `@id:portal-instances`                                        |
| **Audit Log**          | All instances, with filters and CSV export.                                                                                                                     | `@id:portal-audit`                                            |
| **Plugins**            | Installed plugins, install from file (ADR-0013), available plugins and repositories (ADR-0013).                                                                 | `@id:portal-plugins`                                          |
| **Clients & Tokens**   | Bearer tokens, OAuth clients and OAuth grants (ADR-0009).                                                                                                       | `@id:portal-tokens`                                           |
| **Settings**           | Admin only. Six tabs: Client auth, User auth, Users, Roles, Notifications and Server settings.                                                                  | `@id:portal-settings`, `@id:portal-users`, `@id:portal-roles` |
| **My profile**         | Every user, at `/profile`. Own bearer tokens and OAuth grants, theme and approval browsers. A local account also has its password, TOTP and new recovery codes. | `@id:portal-profile`                                          |

Keyboard and screen reader use: `@id:portal-accessibility`.

### Admin API

All routes are on the Admin listener and return JSON. `/api/*` routes need a session cookie. Routes that change state need the CSRF token.

Only an admin can use a route (ADR-0010), with these exceptions: `/api/session`, `/api/setup`, `/api/profile/*` and `/api/me/*`. Core refuses all other routes with 403 for a user with another role. A new route is therefore admin-only. The `/api/me/*` routes check the switches of the role on the endpoint, and return 404 for an endpoint that is not in the role.

```
POST   /auth/login | /auth/totp | /auth/logout | /auth/register (sign-up form, ADR-0010)
GET    /auth/oidc/start | /auth/oidc/callback
GET    /api/session              POST /api/setup (only while there are no users)
GET    /api/overview             GET  /api/events (SSE: instance status, sync progress, lockouts)
GET    /api/profile              POST /api/profile/password | /totp/begin | /totp/confirm | /totp/disable (local accounts only, ADR-0025)
POST   /api/profile/totp/recovery-codes {code}   (new recovery codes, ADR-0008)
GET/POST /api/users {kind, oidcEmail}   PATCH /api/users/:id   POST /api/users/:id/reset-totp
GET    /api/settings             PUT  /api/settings/:section   PUT /api/settings/oidc
GET    /api/settings/mcp/clients-seen (client names seen at initialize, @id:client-policy)
PUT    /api/settings/runtime {runsAtOnce} (total of sandbox runs at once, 2 to 256; null is 16 for each CPU, ADR-0003)
GET    /api/plugins              PATCH /api/plugins/:id {enabled}   DELETE /api/plugins/:id
POST   /api/plugins/install {repoId, pluginId, version}    POST /api/plugins/rescan
POST   /api/plugins/uploads (raw tarball, ADR-0013)   POST /api/plugins/uploads/:uploadId/install
POST   /api/plugins/:id/revert
GET/POST /api/plugin-repos       DELETE /api/plugin-repos/:id
POST   /api/plugin-repos/:id/refresh | /confirm-key {publicKey}     GET /api/plugin-repos/available
GET/POST /api/instances          GET/PATCH/DELETE /api/instances/:id
GET/PUT  /api/instances/:id/connection     POST /api/instances/:id/connection/test
POST   /api/instances/:id/sync
GET    /api/instances/:id/groups
PATCH  /api/instances/:id/groups/:key {level?, label?, acknowledge?}
         (level write needs acknowledge = the exact list of writes; 409 if not current)
POST   /api/instances/:id/groups/merge {from, into, label?}
POST   /api/instances/:id/groups/bulk-level {level, confirm?, acknowledge?}
         (write needs confirm = the slug and the acknowledge list; 409 if not current)
GET    /api/instances/:id/operations?group=&q=&reason=
PATCH  /api/instances/:id/operations/:opId {level? (null = follow the group), acknowledged?, attestationRequired?}
         (409 for level write on a locked operation)
GET    /api/instances/:id/registry          GET /api/instances/:id/options/:source
GET/POST /api/instances/:id/rules           PATCH/DELETE /api/instances/:id/rules/:ruleId (409 on a locked operation)
GET    /api/audit                           GET /api/audit/export.csv
GET/POST/DELETE /api/tokens {name, scope, access, expiresAt}
GET/POST/DELETE /api/oauth/clients          GET/DELETE /api/oauth/grants
GET/POST/PATCH/DELETE /api/notifiers        POST /api/notifiers/:id/test
GET    /api/roles  → [{…, endpoints: [{instanceId, canSetOwnLevels, canManageOwnRules, canSeeStatus}]}]
POST   /api/roles                   PATCH/DELETE /api/roles/:id        PUT /api/roles/:id/instances {instanceIds}
PATCH  /api/roles/:id/endpoints/:instanceId {canSetOwnLevels?, canManageOwnRules?, canSeeStatus?}
GET    /api/roles/:id/endpoints/:instanceId/access
PUT    /api/roles/:id/endpoints/:instanceId/groups/:key | /operations/:opId {level (null = not set)}
POST   /api/roles/:id/endpoints/:instanceId/bulk-level {level}

Every user:
GET    /api/me/endpoints  → {assigned, unassigned}   GET /api/me/endpoints/:id/access
GET    /api/me/endpoints/:id/about         (an unassigned endpoint, with "See other endpoints"; else 404)
PUT    /api/me/endpoints/:id/groups/:key | /operations/:opId {level (null = follow the role)}   (Set personal levels)
GET    /api/me/endpoints/:id/rule-form     GET/POST /api/me/endpoints/:id/rules
GET    /api/me/endpoints/:id/options/:source   GET /api/me/endpoints/:id/registry?kind=
PATCH/DELETE /api/me/endpoints/:id/rules/:ruleId                                             (Own pre-approval rules)
GET/POST/DELETE /api/me/tokens      GET/DELETE /api/me/grants
```

Each route that changes state writes a `config` audit event with the values before and after, with secrets redacted. The "configuration changes" filter of the audit log is `kind=config`.

Feature files: `@id:admin-api-basics`, `@id:audit-log`.

## Maintenance

The core scheduler keeps the catalog of each instance current. An in-process lock for each instance makes calls that start at the same time share one sync.

**When a sync runs.**

| Trigger                     | Rule                                                                                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each `search` and `execute` | If the catalog was never synced, or it came from another bundle version, the sync runs first and must succeed (see below).                                                  |
| Session start               | If `last_synced_at` is older than `syncMaxAge` (default 1 hour), or `getUpstreamVersion()` is not `upstream_version`, the sync runs before the first `search` or `execute`. |
| Open sessions               | Each 30 minutes, a fast version check. If the version changed, the sync runs before the next call.                                                                          |
| Each day                    | A sync for each instance, at a different time for each.                                                                                                                     |
| Admin                       | "Sync now", or `POST /api/instances/:id/sync`.                                                                                                                              |
| Plugin                      | The `catalogChanged` notification starts a sync after a short delay, and at most once a minute for each instance.                                                           |

**Bundle version.** Core records on the instance the bundle version that the catalog came from (`catalog_plugin_version`). Core reads this version from the `manifest.json` of the bundle just before each fork (ADR-0014).

- If the version of the running child is not the recorded one, the sync must succeed first. This happens after an install, an update, or files copied by hand and a restart.
- Until the sync succeeds, the endpoint answers `PLUGIN_UNAVAILABLE`. It never serves a catalog of another bundle, with its locks and its `sensitiveResult`.
- The gate also checks this version for each call (ADR-0003).

**What a sync does.**

- Core maps the `plugin_group` of each operation through `operation_group_aliases`.
- Core creates missing groups at `ask`.
- Core marks groups without operations as `stale` and keeps their level, in case they come back.
- Core marks operations that are missing as `stale`. It never deletes them.
- New writes start without acknowledgement. At level `write` they ask until the admin acknowledges them (ADR-0004).
- `syncRegistry` runs with each sync and after `catalogChanged`. `resolveTargets` uses the live view of the plugin, so scope membership is as it is at the time of the call.

**Sync failure.**

- Core continues to serve the last catalog. It sets `last_sync_status = error` and sends `sync.failed`.
- "Sync now" answers `502 sync_failed` with the redacted reason that `last_sync_status` shows. A plugin that is not running or does not answer in time gives `503 plugin_unavailable`.
- An exception: a bundle version that is not the recorded one (see above).
- An instance without any synced catalog stays in `error`, and its endpoint returns 503.

Feature files: `@id:catalog-sync-schedule`, `@id:catalog-sync`, `@id:catalog-access-on-sync`.

**Repository index refresh.** Each day (ADR-0013). It shows available updates and key changes. It never installs anything. Feature files: `@id:plugin-repositories`.

**Housekeeping** (each hour, idempotent):

- Delete `pre_approval_hits` older than the largest rule window.
- Delete expired sessions, OAuth codes, OAuth tokens and approval-page tokens.
- Delete decided approvals older than 7 days. The audit log keeps their record.
- Delete `audit_log` rows older than `audit.retentionDays`. The default is 90 days, and the minimum is 7. When the admin clears it, core keeps the audit log forever. Core audits a change to this setting and each purge.

Feature files: `@id:housekeeping`.

## Environment

`.env.example` lists every variable: `DATA_DIR`, `MASTER_KEY`, `MCP_HOST`, `MCP_PORT`, `ADMIN_HOST`, `ADMIN_PORT`, `METRICS_HOST`, `METRICS_PORT`, `METRICS_TOKEN`, `PUBLIC_MCP_URL`, `PUBLIC_ADMIN_URL`, `MCP_ALLOWED_HOSTS`, `ADMIN_ALLOWED_HOSTS`, `TRUST_PROXY`, `ADMIN_BOOTSTRAP_USERNAME`, `ADMIN_BOOTSTRAP_PASSWORD`, `ADMIN_FORCE_LOCAL_LOGIN` and `LOG_LEVEL`.

## Server log

Core writes one `LEVEL message key=value` line for each event to stdout or stderr, filtered by `LOG_LEVEL`. A refused MCP request logs its reason, but never a credential value. Request lines hold the path only, because query strings hold OAuth state. A plugin message that breaks the contract logs a warning with the instance slug, never the message. Each instance logs one such line a minute at most, with `suppressed=` for the dropped repeats. A plugin message over 64 MiB stops the plugin, and supervision starts it again (ADR-0020). A fault of core while it handles a plugin message logs an error. The feature files `@id:server-log` and `@id:listeners` specify the log and the health checks.
