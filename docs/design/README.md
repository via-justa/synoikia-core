# Synoikia software design description

This document set is the software design description (SDD) of Synoikia core. It tells what the system does and how its parts do it. It describes the current design only.

## Document rules

- The text uses ASD-STE100 Simplified Technical English. Sentences are short and in the active voice. Each sentence gives one instruction or one fact.
- Each term in the glossary has one meaning. The text does not use other words for these terms.
- Code names (`syncCatalog`, `plugin_instances`) and file paths are technical names. They do not change.
- The documents describe the current design. They do not describe earlier designs, changes, or migrations.
- Section numbers do not change. Code comments refer to them, for example `design §5.2`.

## Sections

| Section | File                                             | Subject                                                                     |
| ------- | ------------------------------------------------ | --------------------------------------------------------------------------- |
| §1      | [01-introduction.md](01-introduction.md)         | Purpose, scope, limits of the design                                        |
| §2      | [02-topology.md](02-topology.md)                 | Process, listeners, endpoint routing                                        |
| §3      | [03-plugin-model.md](03-plugin-model.md)         | Responsibilities, manifest, RPC contract, operation rules                   |
| §4      | [04-plugin-lifecycle.md](04-plugin-lifecycle.md) | Installation, repositories, signatures, isolation, tests                    |
| §5      | [05-call-path.md](05-call-path.md)               | `search`, `execute`, the gate, access levels, approvals, sandbox, redaction |
| §6      | [06-authentication.md](06-authentication.md)     | Portal sign-in, endpoint authentication, access ceiling                     |
| §7      | [07-data.md](07-data.md)                         | Tables, secrets, write ownership                                            |
| §8      | [08-admin-portal.md](08-admin-portal.md)         | Pages, plugin UI, Admin API                                                 |
| §9      | [09-notifications.md](09-notifications.md)       | Notification channels and events                                            |
| §10     | [10-maintenance.md](10-maintenance.md)           | Catalog sync and housekeeping                                               |
| §11     | [11-deployment.md](11-deployment.md)             | Image, proxy, environment, server log                                       |
| §12     | [12-security.md](12-security.md)                 | Trust boundaries and remaining risks                                        |
| §13     | [13-verification.md](13-verification.md)         | Test areas and coverage                                                     |
| §14     | [14-open-items.md](14-open-items.md)             | Items that are not in the design yet                                        |

Diagrams of the system are in [`../architecture.md`](../architecture.md). The plugin author guide is [`../plugin-authoring.md`](../plugin-authoring.md).

## Glossary

| Term              | Meaning                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------- |
| Core              | The Synoikia server process. It owns all security decisions.                                  |
| Upstream          | A self-hosted service that a plugin connects to.                                              |
| Plugin            | A package that describes one kind of upstream API to core. It makes no security decisions.    |
| Instance          | One configured connection of a plugin to one upstream. It runs as one child process.          |
| Endpoint          | The MCP endpoint of one instance, at `/{slug}`.                                               |
| Operation         | One upstream call that the catalog lists, with a stable key.                                  |
| Catalog           | The list of operations of one instance, synced from the plugin.                               |
| Group             | A set of operations that share an access level, for example one API tag.                      |
| Access level      | `none`, `read`, `ask` or `write`. It controls if an operation runs, asks, or is off.          |
| Locked operation  | An operation that always needs a human approval with a typed confirmation.                    |
| Split twin        | A second, locked key for an operation, used when its risk depends on its parameters.          |
| Principal         | The authenticated identity that calls an endpoint.                                            |
| Access ceiling    | The most that a principal can do: `read` or `write`.                                          |
| Approval          | A human decision on one call, made on the approval page.                                      |
| Parked execution  | An `execute` that waits on the server for an approval after its tool call answered.           |
| Approval card     | The MCP Apps view that shows a parked approval in the chat. It cannot approve.                |
| Session grant     | A time-limited permission, given on the approval page, that auto-approves `ask` for a client. |
| Pre-approval rule | A stored rule that approves matching calls without a human.                                   |
| Target            | A concrete upstream object that a call acts on, for example one device.                       |
| Registry          | The local copy of the upstream objects that a plugin lists, for pickers and target selection. |
| Binding           | The function in the sandbox that sends a call to the gate, for example `acme.call(...)`.      |
| Gate              | The permission pipeline between the binding and the plugin.                                   |
| Sandbox           | The `isolated-vm` isolate that runs model code.                                               |
| Attestation key   | A key that shows that the model read a best-practice guide in the same MCP session.           |
| Redaction         | The replacement of secret values with `[REDACTED]`.                                           |
| Audit log         | The append-only log of calls, searches, configuration changes, sign-ins and plugin events.    |
| Bundle            | The built plugin code (`dist/index.js`) with its `manifest.json`.                             |
