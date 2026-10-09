# §5 Call path and gate

## 5.1 `search(code)`

1. Core runs the code in a new `isolated-vm` isolate (§5.4).
2. The code can use these read-only APIs. Core answers them from the database. They never call the plugin.
   - `catalog.find({ text?, group?, tag?, kind?, classification?, includeDisabled? })` returns descriptors. By default it returns only callable operations (§5.2.1). Each has `approval: 'none' | 'required' | 'auto'`: it runs, it asks a human, or it runs without a question at level `write`. With `includeDisabled`, it also returns the other operations, marked `disabled` with a `reason`: `level_none`, `token_read_only` or `locked_not_opted_in`. For a user who is not an admin, it never returns an operation that the user cannot call (§6.4).
   - `catalog.groups()` returns `{ key, label, level, counts: { read, write, locked, pendingReview, overridden } }[]`. The model can then tell the user why an operation is not callable.
   - `catalog.get(key)` returns the full descriptor with `paramsSchema` and docs.
   - `registry.find({ kind?, text?, parent?, scopes? })` returns matching registry entries only, never the full registry. It exists only if the plugin has `registry`.
   - `guides.get(key)` returns `{ content, best_practice_key }`. It exists only if the plugin has `attestation`. See "Attestation" below.
3. Core redacts the return value (§5.5). It limits its size to 64 KB by default and marks a truncated value. Core audits the run as a `search` event.

**Attestation.** Some operations need the model to read a best-practice guide first (`attestationRequired`).

- The key is `HMAC(attestation key, instance ‖ operation key ‖ guide version ‖ MCP session id)`.
- The key works only in the MCP session that read the guide. Core refuses a key from another session.
- A new guide version makes all old keys invalid.
- Core audits each guide read (`search` / `guide_read`) with the guide version and the session.

## 5.2 `execute(code)` and the binding

The sandbox gets `<namespace>.<fn>(...)` for each function in `manifest.binding.functions`. Each call goes through this pipeline:

```
binding(args)
  │
  ├─ 0. resolveOperation (plugin)       → key, params              | UNKNOWN_OPERATION
  ├─ 1. attestation (if required)                                   | ATTESTATION_REQUIRED
  ├─ 2. access level (§5.2.1) under the principal's ceiling         | OPERATION_DISABLED {reason}
  │      mode: run (read) · approve (ask) · auto (write at level write)
  ├─ 3. resolveTargets (plugin, if targets)                         | TARGET_RESOLUTION_FAILED
  ├─ 4. prepareWrite (plugin, configTransform and kind config)      | CONFIG_CONFLICT
  ├─ 5. mode run (read) → invoke
  │     writes: write rate limit checked                            | RATE_LIMITED
  ├─ 6. mode auto → invoke (auto-approved:level)
  │     mode approve: session grant (§5.8) → invoke (auto-approved:grant:<id>)
  │     mode approve: pre-approval rule (never locked) → invoke (auto-approved:rule:<id>)
  ├─ 7. human approval (§5.3), then access checked again            | PERMISSION_DENIED / OPERATION_DISABLED
  ├─ 8. targets resolved again                                      | TARGETS_CHANGED
  ├─ 9. catalog version checked again, write counted                | PLUGIN_UNAVAILABLE / RATE_LIMITED
  ├─ 10. invoke (plugin)                                            | UPSTREAM_* / PLUGIN_*
  ├─ 11. redaction of the result (§5.5)
  └─ 12. audit (each branch, refusals included)
```

**Errors.** Core throws errors into the sandbox as `Error` objects with a `code` property. The model code can catch them. They never stop the host. The codes are:

| Code                       | Cause                                                                                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNKNOWN_OPERATION`        | The plugin cannot map the call to a catalog key.                                                                                                                                                |
| `ATTESTATION_REQUIRED`     | The call has no valid attestation key.                                                                                                                                                          |
| `OPERATION_DISABLED`       | Level `none` (also a write in a group at `read`), a read-only principal, a locked operation without its own `ask`, or a level change while the approval was open. The message gives the reason. |
| `TARGET_RESOLUTION_FAILED` | The plugin cannot resolve a target.                                                                                                                                                             |
| `TARGETS_CHANGED`          | The targets are not the targets that the approver saw. The call must be made again.                                                                                                             |
| `CONFIG_CONFLICT`          | The object changed after it was read (`prepareWrite`).                                                                                                                                          |
| `PERMISSION_DENIED`        | A human denied the call, the client declined, the approval timed out, the client cannot show an approval and cannot park, or the client has too many parked executions.                         |
| `RATE_LIMITED`             | The principal used its write or run budget.                                                                                                                                                     |
| `UPSTREAM_DENIED`          | The upstream refused the call for lack of permission.                                                                                                                                           |
| `UPSTREAM_ERROR`           | The upstream call failed.                                                                                                                                                                       |
| `UPSTREAM_TIMEOUT`         | `invoke` did not answer in time. The result is unknown (see below).                                                                                                                             |
| `PLUGIN_UNAVAILABLE`       | The plugin child is down, or the bundle changed while the call waited.                                                                                                                          |
| `PLUGIN_ERROR`             | The plugin answer is not valid.                                                                                                                                                                 |
| `EXECUTION_ENDED`          | The `execute` run ended before the call, or core stopped its parked execution.                                                                                                                  |

**Rules of the pipeline:**

- **One call at a time.** The calls of one `execute` run in sequence. While a call waits for approval, the full `execute` waits.
- **An `execute` ends with its sandbox.** The run ends when the script returns, throws or times out. It also ends when the MCP request is cancelled or the session closes. Then core refuses the calls that remain (`EXECUTION_ENDED`) and cancels an open approval. A parked execution (§5.6) is the one exception: it continues after the tool call answered, until its script ends or core stops it. It reaches the upstream only after a human decision.
- **Catalog version.** Core reads the catalog version (§10) when it gates a call. It reads it again just before `invoke`. If it is not set or it changed, core refuses the call with `PLUGIN_UNAVAILABLE`. A plugin update or a restart onto other code during the approval then cannot run the call under the rules of another bundle.
- **Timeouts.** Core cannot cancel an `invoke` that timed out. The upstream can still complete the write. Core audits the call as `error:UPSTREAM_TIMEOUT`, which means "result unknown". Each `invoke` has a unique `context.callId`. A plugin can send it to an upstream that supports idempotency keys.
- **`prepareWrite`** runs for write operations of kind `config` on plugins with `configTransform`.
- **Rate limits.** These limits apply for each principal and instance. They are separate from pre-approval rule limits.
  - `execute` and `search` runs: 30 each minute by default. Core refuses a run with `RATE_LIMITED` before it creates an isolate.
  - Upstream writes: 10 each minute by default. Core checks the limit before it asks for an approval. It counts a write only when the write runs, so a denied call costs nothing.
  - Sandboxes: at most 4 at the same time for each instance and 16 in total. Over this limit, core refuses the run with `BUSY`. A parked execution gives back its place and counts against the parked limits (§5.6).

**Pre-approval rules.** A rule approves matching calls without a human. Its `match` is a list of conditions. All conditions must be true.

- `{ field: "/json/pointer", op: "eq" | "in" | "prefix" | "range" | "bool", value }` applies to the normalized parameters. A missing field gives no match.
- `{ field: "$targets", ids?: [], scopes?: { <key>: [] } }` is true only if each resolved target meets all given selectors. Its id must be in `ids`. For each scope key, its value must be in the list. A target with no value for a selected scope does not match. Zero targets gives no match. A rule can use only the scope keys that the `$targets` field of the operation offers (§3.2).
- **Strict matching.** A condition must cover each parameter of the call. A condition on a path covers everything below it.
  - A `$targets` condition also covers the parameter subtrees in its field's `covers`, because it already checks each target.
  - A parameter that the rule does not mention must be absent. `{ field, op: "any" }` accepts it. `{ field: "", op: "any" }` accepts all parameters, and the portal marks this "not recommended".
  - An empty `match` matches only calls without parameters.
  - If the conditions were true but the call had extra parameters, core records `strict_miss_at` on the rule. The rule list shows this.
- `prefix` matches at a path segment boundary. `tank/media` matches `tank/media` and `tank/media/tv`, but not `tank/media-private`.
- `rate_limit` and `window_seconds` use `pre_approval_hits`. Over the limit, the call goes to a human. Core does not refuse it.
- A rule applies only at level `ask`. It never applies to a locked operation. A rule on a hidden operation, or on one at level `write`, has no effect, and the rule list shows this.
- An admin rule has no owner. It applies to the calls of all users. An own rule (§6.4) has an owner. It applies only to the calls of its owner, and only while the role of the owner allows own rules.

## 5.2.1 Access levels

Each operation has an access level. The admin usually sets the level for a group. The plugin gives the groups (§3.2). When the admin sets the level of a group, all operations in the group follow it. The admin can give one operation its own level. That level applies until the admin sets the group level again, or clicks ↺.

Read or write comes from the upstream API, through the plugin. For example, a REST plugin uses the HTTP method. The admin cannot change a classification. Only a `plugin.yaml` rule can (§3.4).

**Group levels.** The meaning of a group level for each kind of operation:

| Group level | Read operations | Write operations                                          | Locked operations                                       |
| ----------- | --------------- | --------------------------------------------------------- | ------------------------------------------------------- |
| `none`      | off             | off                                                       | off                                                     |
| `read`      | run             | off                                                       | off                                                     |
| `ask`       | run             | each call asks for approval; pre-approval rules can apply | only with their own `ask`                               |
| `write`     | run             | run without a question after acknowledgement              | only with their own `ask`; never run without a question |

**Own levels.** An operation can have only the levels that its kind allows:

| Kind   | Own levels             | Meaning                                                              |
| ------ | ---------------------- | -------------------------------------------------------------------- |
| read   | `none`, `read`, `ask`  | off · runs · each call asks                                          |
| write  | `none`, `ask`, `write` | off · each call asks · runs without a question after acknowledgement |
| locked | `none`, `ask`          | off · each call asks, with typed confirmation and a new TOTP code    |

**Roles.** The levels above are the levels of the endpoint. They apply to the Admin role. For a user with another role (§6.4), two more layers limit them:

- **Role maximum.** The admin sets it for each group of an endpoint, and for an operation if necessary. It has the same "follow the group" meaning as the endpoint level. A group or operation without a role maximum is `none`.
- **Personal level.** A user sets it if the role allows personal levels. It has the same meaning. If it is not set, the role maximum applies.

The level in force for the user is the most restrictive of the three. For one operation, the order from restrictive to open is `none`, `ask`, `read`, `write`. A role maximum and a personal level never open more than the endpoint level.

One function, `effectiveAccess` in `packages/core/src/gate/access.ts`, makes this decision. The gate, `search` and the portal all use it:

```
effectiveAccess(op, group, principal):
  group missing or level not known  → hidden (group_missing)
  level = level in force            -- own level (narrowed to its kind), else the group table
  principal is not admin:
    endpoint not in the role        → hidden (not_in_role)
    level = most restrictive of level, role maximum, personal level
  level == none                     → hidden (locked_not_opted_in for a locked op, else level_none)
  op is read and not locked         → run, or approve at its own ask
  principal ceiling == read         → hidden (token_read_only)
  level == ask, or op is locked     → approve
  write not acknowledged            → approve (pendingReview)
  otherwise                         → auto
```

**Locked operations.**

- They never follow their group into `ask` or `write`.
- A locked operation is callable only when the admin sets its own level to `ask`.
- Core refuses `write` for a locked operation: 409 from the API, disabled in the portal.
- Each call needs a human, a typed confirmation and a new TOTP code (§5.3).
- A pre-approval rule can never apply to a locked operation.

**Acknowledgement.** At level `write`, calls run without a question. When the admin selects `write`, they acknowledge this. There is no other confirmation step.

- When a group goes to `write`, core acknowledges each write in it that is not locked. The audit event lists them.
- When one operation goes to `write`, core acknowledges it.
- A write that is not acknowledged asks, also at level `write`. The group shows "N to acknowledge".

**Catalog sync and access.** A sync never opens an operation by itself.

- A new operation in an existing group gets its own level: `read` for a read, `none` for a write. In a group at `none`, it follows the group. A new operation in a new group follows the group. Core sends `sync.pending_review` for new writes (§9).
- A change from read to write resets the acknowledgement. So do these changes to an acknowledged write: its parameter schema, its kind, its match profile, its lock, or its return from stale.
- If the own level of an operation does not fit its new kind, core narrows it. For example, a read at `read` becomes `none` when it becomes a write.
- If a sync locks an operation, core clears its own level. The operation is then off until the admin sets `ask`.
- If the plugin moves an operation to another group, the operation keeps the access that it had. If the new group gives different access, the operation gets its own level.
- Each sync checks enabled pre-approval rules against the new catalog and the match profiles. Core disables and audits each rule that does not fit (`rules_disabled_operation_changed`). The `sync.pending_review` notification counts them.

**Defaults.** A new group starts at `ask`: reads run and each write asks. Locked operations stay off until the admin sets each one to `ask`. The access ceiling of a credential (§6.3) is `read` by default, which also keeps a client away from writes.

**Bulk action.** The Access page has one "Set all groups…" control. Each choice applies after one confirmation. All operations then follow their groups. `write` acknowledges each write that is not locked. Core audits the action as one `config` event with the levels before and after, and the acknowledged writes.

**Regroup.** The groups of the plugin are the default. The admin can merge groups and change labels. Core stores a merge as an alias (`plugin_group → group_key`) and applies it at each sync. A merge of groups with different levels takes the lower level.

## 5.3 Human approval

A human must make an approval, not the client that made the call. The answer to a form prompt goes back through the calling client. A scripted client, or a client under prompt injection, could then approve its own writes. For this reason, core shows its own approval page.

1. **Pending approval.** Core creates a `pending_approvals` row with:
   - the instance, the operation key, and the redacted parameters for display;
   - `params_hash`: SHA-256 over the canonical JSON of the key, the parameters, the resolved targets and the expected hash;
   - the summary, `confirm_literal` and the diff;
   - the client identity, the user who owns the credential (`owner_user_id`), and the MCP session;
   - `expires_at`: 15 minutes by default, set for each instance.
     Core keeps the parameters that are not redacted in memory only.
2. **Channel.** Core uses the first channel that applies, in this order:
   - **URL-mode elicitation.** This is the approval path. Core makes a single-use page token (`approval_links`, stored as a hash, valid until the approval expires). It calls `elicitInput({ mode: 'url', url: PUBLIC_MCP_URL/a/<token>, elicitationId, message })`. The human opens the page, signs in, and decides there. The client never sees the decision form or the literal. The answer of the client only tells if the page opened (`accept`). `decline` and `cancel` deny. After the decision, core sends `notifications/elicitation/complete` and makes the token invalid.
   - **Form elicitation.** The endpoint must allow it with `formElicitationApprovals: 'writes'`. The default is `off`, and the portal shows a warning. The operation must be a plain write: not locked and without typed confirmation. The form has one `approve` value. The audit records `decided_via: elicitation` and the client as `decided_by`.
   - **Link.** The client has no channel above. The execution parks (§5.6). Core makes the same single-use page token and returns the page link in the tool result. The approval card (§5.7) shows it, or the agent shows it as text. The human decides on the page.
   - **No channel.** A caller that cannot park, for example a script through the test harness, has no channel. Core denies the call at once: `client_cannot_approve` for a client with forms only, `no_approval_path` for a client without prompts. Over the parked limits, core denies with `too_many_parked`.
3. **Approval page** (`/a/:token` on the MCP listener). The page needs:
   - a signed-in portal user with TOTP;
   - a TOTP proof in this browser session, given once (a password and TOTP sign-in counts; after an OIDC sign-in, the first approval asks for a code). The session lasts `approvalSessionIdleHours` without use (12 h by default) and at most `approvalSessionAbsoluteDays` (7 days by default). A restart of core clears the proofs, so the next approval asks for a code again. A TOTP reset, a new enrollment or turning TOTP off signs out all approval sessions of the user. A lower setting also shortens the sessions that exist;
   - for a locked operation, a TOTP code from the last 5 minutes;
   - a POST with a CSRF token. A GET or a prefetch decides nothing.
     `decided_by` is the user name. `decided_via` is `url`. The page has three choices: **Deny**, **Approve once** and **Approve for this session** (§5.8).
4. **Typed confirmation.** For an operation with typed confirmation, the approver must type `confirm_literal` exactly. Otherwise core returns 400 and the approver can try again. `summarize` gets redacted parameters, so the summary and the literal cannot hold a secret. If such an operation has no literal, core refuses the call.
5. **Targets checked again.** For plugins with `targets`, core resolves the targets again after the approval. If they are not the targets that the approver saw, core refuses the call (`TARGETS_CHANGED`). The plugin gets the approved targets in `InvokeContext.targets`.
6. **Access checked again.** If the admin lowered the level while the approval was open, core refuses the call (`access_changed`).
7. **Single use.** An approval allows one `invoke` of exactly its `params_hash`. A new call makes a new approval.
8. **Timeout.** An approval that times out is denied and logged as `timed-out`. Core never allows a call on timeout.
9. **Tool annotations.** `search` has `readOnlyHint: true`. `execute` has `readOnlyHint: false, destructiveHint: true, openWorldHint: true`. Clients that confirm tool calls themselves use these hints. The gate does not depend on them.
10. **Who can approve.** Only the user who owns the credential of the call (§6.4). Another user gets 403 and does not see the call, also if that user is an admin. A call without an owner can come only from inside core, for example the test harness. For such a call, an admin decides. The approver must sign in on the MCP listener with TOTP. Each decision records who made it.
11. **Redacted values.** The approval page shows the same redacted parameters as the audit log. A value under a sensitive key shows as `[REDACTED]`. The approval page must not show secrets. A plugin summary for such an operation tells what changes without the value.

**Approval states.**

| From      | To          | When                                                                                                         |
| --------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| `pending` | `approved`  | A human approves on the page, or the client approves an allowed form.                                        |
| `pending` | `denied`    | A human denies, the client declines, there is no channel, or core restarts.                                  |
| `pending` | `timed_out` | `expires_at` passes.                                                                                         |
| `pending` | `cancelled` | The `execute` ends, the session closes (not for a parked execution), the endpoint stops, or core shuts down. |

## 5.4 Sandbox

- Core uses `isolated-vm` 6.2 with its prebuilt binaries. Node runs with `--no-node-snapshot`, which `isolated-vm` needs.
- Each `execute` and `search` gets a new isolate. Core disposes of it after the run and never uses it again.
- `code` is the body of an async function. It can `await` bindings and `return` a value that JSON can encode. All values cross the boundary as JSON.
- An error in the isolate comes back as `{ code, message }`. A binding error is an `Error` with `err.code` in the sandbox, so the code can catch it.
- **Limits for each run** (an instance can change them):

  | Limit       | Default | Notes                                                          |
  | ----------- | ------- | -------------------------------------------------------------- |
  | Time        | 10 s    | Time that a binding waits for a human approval does not count. |
  | Memory      | 64 MB   |                                                                |
  | Result size | 64 KB   | A larger result comes back as `{ truncated, bytes, preview }`. |
  | Logs        | 16 KB   |                                                                |

  The time limit stops loops that are synchronous (V8 timeout) and asynchronous (core disposes of the isolate).

- **Available in the sandbox:** the binding functions, `catalog`, `registry` and `guides` (in `search` only), and `console.log`. Core captures the logs and returns them as `logs`.
- **Not available:** `require`, `import`, `process`, `fetch`, timers and host objects.
- **Isolation of the host references.**
  - A prelude script runs before the user code. It keeps the host references in its closure.
  - The user code is a separate script, so it cannot get these references.
  - The prelude freezes the binding namespaces and deletes `__syn` from the global object.
  - The host calls only its own binding properties (`Object.hasOwn`).

## 5.5 Redaction

Core replaces values with `"[REDACTED]"` in results, parameters, summaries and diffs. Keys match these lists:

- The global list: `password`, `passphrase`, `secret`, `token`, `apiKey`, `privateKey`, `bindpw`, `authPass`, `accessToken`, `refreshToken`, `clientSecret`, `authorization`, `credential`, `cookie`, `passwd`, `pass`, `pwd`.
- The `sensitiveKeys` of the plugin.
- The extra keys of the instance, set in the portal.

**Key matching.**

- Keys match without regard to case, and `_` and `-` are ignored.
- A key matches a rule if it is equal to it or contains it (`db_password`, `X-Api-Key`, `ssh_private_key`).
- A rule shorter than five characters (`pass`, `pwd`) matches only as the last word of a key (`smtp_pass`). So `bypass` stays visible.
- For a key that only contains a rule, booleans and numbers stay visible (`password_set: true`, `max_tokens: 4096`).

**Secret parameters without a key name.** A parameter can hold a secret without a key that tells it, for example a password as the second positional argument. A descriptor declares these as `sensitiveParams`: JSON pointers into the parameters (`/1`, `/0/password`). Core replaces them wherever it shows or stores parameters: the input of `summarize`, pending approvals and their notifications, and the audit log. `invoke` gets the real values.

**Secret results without a key name.** A result can hold a secret under a key that tells nothing, for example a generated token in `value` or a keytab in `file`. A descriptor declares these as `sensitiveResult`:

- `'whole'`: the full result is a secret.
- `{ keys, deep? }`: each non-empty value under one of these exact key names, in the result or in each row of it. With `deep`, at any depth. A value deeper than 16 levels is hidden too.

Core stores the declaration with the operation. It applies it to the raw `invoke` result first, then applies the instance redactor. Nothing else sees the raw result. The SDK function `maskSensitiveResult` does this masking, and core calls it. One case stays in the plugin: a result that holds the results of other operations, for example the records of a job queue. Core cannot know which operation made each record. The plugin masks each record with the rule of its own operation (`rules.maskEmbeddedResult`).

**Diffs.** A `prepareWrite` diff names each changed field in a path (`/smtp/password`). Key redaction does not see this. So core hides `before` and `after` of an entry if its path has a sensitive segment. It also hides them at or below a `sensitiveParams` path. A `__proto__` key in parameters stays a visible key in each redacted copy. Approvers and the audit log see all that the plugin gets.

**Secret values in text.** Text has no keys. So each instance redactor also removes the actual secret values of the instance from each string. It also removes their URL-encoded and JSON-encoded forms, if they have 6 or more characters.

**Where redaction applies.**

- Values that go to the model: the sandbox result (before core truncates it), each `console.log` argument, and error messages.
- `registry.find` results, at the source.
- Plugin and upstream error messages, before they reach the model.
- The audit log and pending approvals.
- The portal.

**Parameters in memory only.** The database stores only the redacted copy and `params_hash` of an open approval. The real parameters stay in memory.

- **Graceful shutdown** (SIGTERM, SIGINT):
  1. Core cancels open approvals, so waiting clients get a denial.
  2. Core closes MCP sessions and portal event streams.
  3. The listeners stop. After 5 s, core cuts the remaining connections.
  4. Core stops the plugin children and the database.
- **Endpoint stop.** When an endpoint stops (disabled, deleted, plugin disabled, or restarted after a connection change), core cancels its open approvals.
- **Crash.** After a crash, core denies the pending rows at the next start (`denied: server_restart`).

An approval must never apply to parameters that the approver did not see.

## 5.6 Parked executions and `resume`

A client without a usable prompt, for example a chat client without elicitation, still gets each approval. The execution parks: it waits on the server, and the tool call answers at once.

**Flow.**

1. A binding needs a human decision, and no client prompt applies (§5.3). The caller can park.
2. Core makes the pending approval and the page token. It writes the audit event `awaiting_approval` with the `executionId`, the `approvalId` and `channel: link`.
3. The `execute` call returns `status: awaiting_approval`, the `executionId` and `approval` (`url`, `operationKey`, `summary`, `expiresAt`). This is not an error result.
4. The human decides on the approval page.
5. The script continues at the decision. It does not wait for `resume`. The sandbox time limit starts again.
6. The agent calls `resume(executionId)`. `resume` waits up to 45 s for a change. It returns one of these:
   - the result of the script, after which core forgets the execution;
   - `awaiting_approval` with the same link, if the human did not decide yet;
   - `awaiting_approval` with a new link, if the script reached another approval;
   - `running` with `STILL_RUNNING`, if the script still runs after the decision;
   - `EXECUTION_NOT_FOUND`, for an unknown or collected id, an id of another principal or endpoint, or an id from before a restart.

Each write of a parked script runs once. The agent must not run the code again.

**Park again.** A parked script can park again for its next approval only if each approval before it was given. It can park at most 10 times. Otherwise core denies the call at once (`park_refused`). A loop that catches denials and asks again then ends with the sandbox time limit.

**Credential.** A parked execution outlives the request that authenticated it. So the gate checks the credential before each call and again after the approval. A revoked token, a revoked OAuth grant or client, a disabled user, or a token no longer scoped to the endpoint stops the call with `OPERATION_DISABLED`.

**Owner.** A parked execution belongs to the principal and the endpoint that started it. The MCP session is not part of the owner, because a chat client can open a new session. A request of another owner gets `EXECUTION_NOT_FOUND`, the same as an unknown id.

**Limits.**

| Limit                                             | Value  |
| ------------------------------------------------- | ------ |
| Parked executions for each principal and endpoint | 2      |
| Parked executions for each endpoint               | 8      |
| Parked executions in total                        | 32     |
| Wait of one `resume`                              | 45 s   |
| Time a finished result waits for `resume`         | 10 min |

One `resume` at a time can wait on an execution. A second one gets `BUSY`.

**End.** A parked execution ends when its script ends. Its approval times out as in §5.3. When the endpoint stops, core cancels the approval, stops the execution and refuses its remaining calls. At shutdown, core cancels all approvals. A restart loses all parked executions, and core denies their pending rows (§5.5).

**Audit.** Each `resume` writes a `call` event with `decision: resumed` and the `executionId`. With `awaiting_approval` and the decision, it gives one trace for each execution.

## 5.7 Approval card

The approval card is an MCP Apps view (extension `io.modelcontextprotocol/ui`). Hosts that support MCP Apps show it in the chat for each `execute` and `resume` result.

- **Resource.** `ui://synoikia/approval`, MIME type `text/html;profile=mcp-app`. Core serves static HTML and script. It loads nothing from other origins and declares no CSP domains.
- **Tools.** `execute` and `resume` set `_meta.ui.resourceUri` to the card. Two tools have `_meta.ui.visibility: ["app"]`, so the model does not see them:
  - `approval_status(executionId)` returns the state of a parked execution: `pending`, `approved`, `denied`, `timed_out`, `cancelled`, `running` or `done`, with `expiresAt` and the last decision. It never returns parameters, results or the name of the approver. It has the owner check of `resume`.
  - `session_grant_revoke(grantId)` ends a session grant of the same principal and endpoint.
- **The card never decides.** It has no approve control and takes no TOTP code. It shows the state and opens the approval page through `ui/open-link`. The host renders the card from the tool result, so the agent cannot change the link.
- **Continue.** When the state is final, the card sends one `ui/message` to the chat ("Approved, continue."). The agent then calls `resume`. If the host refuses the message, the card asks the user to say "continue".
- **Session grant.** When a session grant is active, the result has `sessionGrant` (`id`, `expiresAt`). The card shows it with a **Revoke** control.
- A host without MCP Apps ignores the card. The agent shows the link from the text result.

At session start, core logs the elicitation mode of the client (`none`, `form` or `url`) and if it supports MCP Apps.

## 5.8 Session grants

A session grant lets one principal run the operations at `ask` on one endpoint without a question, for a time.

- **Who gives it.** Only a human on the approval page, with **Approve for this session**, when the human approves a call. A client, the card and form elicitation cannot give one. **Approve once** is the main button, and the shortest length is the default.
- **Scope.** The principal (the credential) and the endpoint of the approved call. A new grant for the same principal and endpoint replaces the old one.
- **Length.** 1 h, 4 h or until midnight (server time). The endpoint setting `sessionGrantMaxHours` (8 by default) is the maximum. `0` removes the choice from the page. Core applies the maximum again when it makes the grant.
- **Effect.** At step 6 of the gate, an operation at `ask` runs with `auto-approved:grant:<id>`. The `catalog` entries show `approval: auto`. These do not change:
  - Locked operations and operations with typed confirmation always need a human. The page does not offer a grant for them.
  - Level `none`, a group at `read` and the access ceiling still refuse.
  - The write rate limit, attestation, target resolution, redaction and the audit still apply.
- **End.** At its expiry, with **Revoke** on the card or in the portal (endpoint settings, "Active session approvals"), when the endpoint stops, or at a restart. Core keeps grants in memory only.
- **Audit.** `config` events `session_grant.created` (approver, client, approval, expiry) and `session_grant.ended` (reason: `expired`, `revoked`, `replaced`, `endpoint_stopped`).
