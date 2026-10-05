# §8 Admin portal

The admin portal is a Vue 3 single-page app (Vite, vue-router, Pinia). The Admin listener serves it as static files. Its visual style uses the Synoikia brand, in a light and a dark theme. Terracotta marks the one primary action of a page. The fonts are Fraunces for the word mark and IBM Plex Sans and Mono for all other text.

## 8.1 Navigation

```
┌ Sidebar ──────────────────┐
│ Synoikia                  │
│ Overview                  │  all endpoints
│ Audit Log                 │  all instances
│ ENDPOINTS                 │
│ ▾ /acme      ● Ready      │  open when selected
│     Connection            │
│     Access                │  access levels (§5.2.1)
│     Pre-Approval Rules    │
│     Settings              │
│ ▸ /other     ● Error      │
│ + New endpoint            │
│ Plugins                   │
│ Clients & Tokens          │
│ Settings                  │
│ admin · Sign out          │
└───────────────────────────┘
```

## 8.2 Pages

| Page                   | Content                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sign in**            | User name and password, a TOTP step if enabled, "Sign in with <provider>" if OIDC is on, and lockout messages.                                                                                                                                                                                                                                                                |
| **Setup**              | Only while there are no users: create the first admin, and optionally enroll TOTP.                                                                                                                                                                                                                                                                                            |
| **Overview**           | A card for each instance: plugin, slug, endpoint URL (with a copy button), authentication mode, status, last sync. Plugin child and notifier health. Instructions to connect a client.                                                                                                                                                                                        |
| **Connection**         | The connection form from the plugin schema (§8.3): fields, secret fields with a hint and "Rotate", Save, Test connection. Status, Sync now, last sync, upstream version, number of operations, new operations, `sourceRef`. The plugin help text and conditional fields.                                                                                                      |
| **Access**             | See below.                                                                                                                                                                                                                                                                                                                                                                    |
| **Pre-Approval Rules** | The rule list with rate limit and last use. The editor has an operation picker (locked operations are not in it), a match editor from the match profile of the operation, rate limit, expiry, a required reason, and an enabled switch. A warning for an empty match.                                                                                                         |
| **Endpoint Settings**  | Display name, slug (a change warns that clients must be configured again), enabled, authentication mode, approval timeout, `formElicitationApprovals` (with a warning that a client could then approve its own writes), rate limits, sandbox limits, extra redaction keys, memory limit. Delete (type the slug to confirm; the audit log keeps the history).                  |
| **Audit Log**          | All instances. Columns for time, instance, kind, actor, operation, decision. Filters: instance, kind, decision, time range, operation, target. CSV export. An `auto-approved` row links to its rule.                                                                                                                                                                          |
| **Plugins**            | **Installed**: version, signed or unsigned, status, enable switch, instances, update, uninstall (not possible while instances exist), rescan. **Available**: plugins of all repositories, with install and a review of the permissions and network hosts. **Repositories**: add a URL, select the signing mode, confirm the key, refresh, a banner for a changed key, remove. |
| **Clients & Tokens**   | Bearer tokens (create with scope, access ceiling and expiry; shown once; revoke). OAuth clients (registered by DCR or by the admin; revoke). OAuth grants for each user (revoke).                                                                                                                                                                                             |
| **Settings**           | _MCP access_: default authentication mode, Cloudflare Access, trusted identity header, dynamic client registration, `PUBLIC_MCP_URL`. _Admin UI security_: OIDC, allow policy, automatic users, required TOTP, local sign-in off. _Users_: list, add, disable, reset TOTP. _Notifications_: channels (§9). _My profile_: password, TOTP, OIDC link, theme.                    |

**Access page.**

- **Group list.** Each group shows its label and key, and a None / Read / Ask / Write control with tooltips. It shows the numbers of read, write and locked operations, "N with their own level", "N to acknowledge", and NEW and STALE badges.
- **Write dialog.** When the admin sets a group to Write, a dialog lists the writes that will then run without a question.
- **Operations.** When the admin opens a group, it shows its operations, with the label from `manifest.labels`. Each operation shows:
  - its key and what a call does now: runs, asks, runs without a question, or why it is off;
  - a level control: "Follow group" and the levels that its kind allows. A locked operation cannot get Write. Ask on a locked operation, and Write on a write, ask for confirmation;
  - "Acknowledge" on writes that ask until acknowledged;
  - the `attestation_required` switch, for plugins with `attestation`. If the admin turns it off, a later sync does not turn it on again.
- **Tools.** Search in all groups and operations, a "Needs attention" filter, a Regroup dialog (merge and rename), and "Set all groups…". Write for all groups needs the slug typed as confirmation.

## 8.3 Plugin UI from data

Plugins never send JavaScript to the portal. The plugin parts of the UI come from JSON Schema and UI hints. A fixed widget library in core shows them:

| Widget                                    | Use                                                                                                                                                                                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`, `url`, `number`, `bool`, `select` | Connection fields, simple match fields                                                                                                                                                                                                        |
| `secret`                                  | Write-only credential fields: a hint and "Rotate"                                                                                                                                                                                             |
| `multiselect`                             | Fixed options, or options from `optionsFor(source)`                                                                                                                                                                                           |
| `prefix`                                  | A path or name prefix                                                                                                                                                                                                                         |
| `range`                                   | A number range with a unit                                                                                                                                                                                                                    |
| `registry-picker`                         | A `$targets` selector from the plugin `targets` (§3.2): one chips input for each scope that the field offers, with suggestions from the registry, and one for target ids. It uses `GET /api/instances/:id/registry?kind=&text=&scope.<key>=`. |
| `diff`                                    | The before and after values on the approval page                                                                                                                                                                                              |

A new widget is a core change. A manifest with an unknown widget name is not valid, so a plugin cannot fall back to a free-text field without notice.

- `showWhen: { field, in: [...] }` shows a connection field only for some values of another field.
- `connection.help` (Markdown) shows above the form as setup steps.
- Conditional requirements use JSON Schema (`allOf` with `if` and `then`). The server validates them.

## 8.4 Admin API

All routes are on the Admin listener and return JSON. `/api/*` routes need a session cookie. Routes that change state need the CSRF token.

```
POST   /auth/login | /auth/totp | /auth/logout
GET    /auth/oidc/start | /auth/oidc/callback | /auth/oidc/link
GET    /api/session              POST /api/setup (only while there are no users)
GET    /api/overview             GET  /api/events (SSE: instance status, sync progress, lockouts)
GET    /api/profile              POST /api/profile/password | /totp/begin | /totp/confirm | /totp/disable | /oidc/unlink
GET/POST /api/users              PATCH /api/users/:id         POST /api/users/:id/reset-totp
GET    /api/settings             PUT  /api/settings/:section   PUT /api/settings/oidc
GET    /api/plugins              PATCH /api/plugins/:id {enabled}   DELETE /api/plugins/:id
POST   /api/plugins/install {repoId, pluginId, version, confirm}    POST /api/plugins/rescan
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
```

Each route that changes state writes a `config` audit event with the values before and after, with secrets redacted. The "configuration changes" filter of the audit log is `kind=config`.
