# §7 Data

Core keeps all data in one SQLite file, `DATA_DIR/synoikia.sqlite` (default `/data`). It opens the file with better-sqlite3 in WAL mode. The schema is in `packages/core/src/db/schema.ts`. Drizzle generates the migrations in `packages/core/drizzle/`, and core applies them at start. JSON values are stored as `TEXT`. Timestamps are epoch milliseconds.

## 7.1 Tables

**Identity and admin authentication**

| Table         | Holds                                                                                                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`       | `username` (unique), `password_hash`, `totp_secret_enc`, `totp_enabled`, `totp_last_step`, `recovery_codes_hash`, `oidc_issuer`, `oidc_subject`, `last_login_at`, `disabled`, `role_id` |
| `roles`       | `name` (unique), `built_in` (the Admin role, id `admin`), `can_set_own_levels`, `can_manage_own_rules`, `can_see_status`                                                                |
| `sessions`    | `id_hash` (key), `user_id`, `kind` (`admin`, `oauth_ui`, `approval_ui`), `last_seen_at`, `expires_at`, `ip`, `user_agent`                                                               |
| `settings`    | `key`, `value` (JSON): authentication defaults, rate limits, flags                                                                                                                      |
| `oidc_config` | One row: `issuer`, `client_id`, `client_secret_enc`, `scopes`, `allow_policy`, `auto_provision`, `enabled`                                                                              |

**Plugins**

| Table              | Holds                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin_repos`     | `url` (unique), `name`, `signing_mode` (`signed`, `unsigned`), `public_key`, `key_fingerprint`, `key_status` (`ok`, `key_changed`), `index_cache`, `last_fetched_at`, `last_fetch_error`                                                                                                                                                                         |
| `plugins`          | `plugin_id` (unique: one installed version for each id), `version`, `repo_id`, `path`, `sha256`, `signature_verified`, `manifest`, `status` (`ok`, `invalid`, `incompatible`), `status_error`, `enabled`                                                                                                                                                         |
| `plugin_instances` | `plugin_id`, `slug` (unique), `display_name`, `enabled`, `config`, `secrets_enc`, `auth_mode` (NULL: the global default), `settings` (approval timeout, rate limits, sandbox limits), `status` (`stopped`, `starting`, `ready`, `error`), `status_error`, `upstream_version`, `source_ref`, `last_synced_at`, `last_sync_status`, `catalog_plugin_version` (§10) |

**Catalog** (for each instance)

| Table                     | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operation_groups`        | `instance_id`, `key`, `label`, `level` (`none`, `read`, `ask`, `write`), `level_changed_at`, `level_changed_by`, `first_seen_at`, `stale`                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `operation_group_aliases` | `instance_id`, `plugin_group`, `group_key`: the merges of the admin                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `operations`              | `instance_id`, `key`, `display_name`, `kind`, `tag`, `classification` (`read`, `write`; locked means write), `classification_source` (`locked`, `inferred`), `inferred_classification`, `inferred_reason`, `plugin_group`, `group_id`, `locked`, `level_override` (NULL: follows the group), `write_acknowledged`, `acknowledged_at`, `acknowledged_by`, `typed_confirmation`, `attestation_required`, `attestation_waived`, `needs_review`, `match_profile`, `params_schema`, `sensitive_params`, `sensitive_result`, `docs`, `first_seen_at`, `last_seen_at`, `stale` |
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

**Roles** (§6.4)

| Table            | Holds                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `role_instances` | `role_id`, `instance_id`: the endpoints of a role                                                          |
| `role_levels`    | `role_id`, `instance_id`, `group_id` or `operation_id`, `level`, `changed_at`, `changed_by`: role maximums |
| `user_levels`    | `user_id`, `instance_id`, `group_id` or `operation_id`, `level`, `changed_at`: own levels                  |

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

**Stored JSON from an older release.** Core reads stored JSON settings (global and for each instance) in a lenient mode. If the current schema refuses a field, core uses its default and logs a warning. At start, core removes the refused fields from the stored JSON once. It keeps valid fields as they are, so new defaults apply to fields that nobody set. Discovery validates plugin manifests again at each start. Core marks a plugin with a manifest that is no longer valid as unusable, and its endpoints return 503.

## 7.2 Secrets and master key

**Master key.**

- `MASTER_KEY` (32 bytes, base64) comes from the environment.
- If it is not set, core reads or creates `DATA_DIR/master.key` (mode 0600) at the first start. Core logs a warning: move the key out of the data volume.

**Encryption.**

- AES-256-GCM with a random 96-bit nonce for each value.
- The stored value is `v1 ‖ nonce ‖ ciphertext ‖ tag`.
- The associated data is `table:column:row-id`, so a value copied to another row does not decrypt.

**Encrypted columns.** `plugin_instances.secrets_enc` (all `writeOnly` connection fields), `users.totp_secret_enc`, `oidc_config.client_secret_enc`, `notifier_channels.secrets_enc`.

**Secrets in the Admin API.**

- The API never returns a decrypted secret. `GET` returns `{ set: true, hint: "…ab12" }` for each secret field.
- `PUT` with a secret field replaces it. If the field is not in the request, core keeps the old value.
- Exception: the request changes where the upstream is. This is a non-secret field with a `uri`, `hostname` or IP format, or with a name like `url`, `host`, `server`, `endpoint` or `address`. Core then does not use the stored secrets, for a save and for "Test connection". The request must give them again (`400 secrets_required`). A changed URL thus never gets the stored key.

**Key rotation.** `node dist/cli.js rotate-master-key` changes the master key.

- The server must be stopped. A running server holds `DATA_DIR/server.lock` with its pid and host. The command refuses to run while that process is alive, because the server keeps the old key in memory.
- A lock from another host (another container on the same volume) always counts as held. `--force` overrides this when the operator knows that the server is stopped.
- The command first decrypts all encrypted columns, then encrypts them again in one transaction. A wrong current key changes nothing.
- With a key file, the command writes the new key to `master.key.new` before it changes the database. Then it moves the file over `master.key`.
- With `MASTER_KEY` in the environment, the new key must be in `NEW_MASTER_KEY`.
- The command deletes all sessions, because their pepper comes from the master key.

**Derived keys.** HKDF makes these keys from the master key: the attestation HMAC key, the signed-state key (MFA and consent forms), and the session-id pepper. Approval-link tokens are random and stored as SHA-256 hashes. They need no key.

## 7.3 Write ownership

| Writer                       | Tables                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin API (signed-in user)   | `users`, `settings`, `oidc_config`, `plugin_repos`, `plugins`, `plugin_instances`, `operation_groups.{level, label}`, `operation_group_aliases`, `operations.{level_override, write_acknowledged, attestation_required}`, `pre_approval_rules`, `mcp_tokens`, `oauth_clients` (admin), `notifier_channels` |
| Catalog sync (plugin output) | `operations` (inserts, inferred fields, `stale`, `last_seen_at`, locked seeds, `sensitive_*`, acknowledgement resets), `pre_approval_rules.enabled` (off only), `operation_groups` (inserts at `ask`, `stale`), `registry_entries`, `guides`, the sync columns of `plugin_instances`                       |
| Gate and approval service    | `pending_approvals`, `approval_links`, `pre_approval_hits`, `audit_log`                                                                                                                                                                                                                                    |
| OAuth server                 | `oauth_*`, `sessions` (kind `oauth_ui`)                                                                                                                                                                                                                                                                    |
| Nobody                       | `audit_log` rows are never changed or deleted through an API                                                                                                                                                                                                                                               |

**Rules that the service layer enforces** (tests cover them):

- Only a sync can set `locked`, from a plugin seed. The API cannot clear it. The API cannot change a classification at all.
- `PATCH` with level `write` on a locked operation returns 409.
- A pre-approval rule can never refer to a locked operation. `POST` and `PATCH` return 409. A sync that locks an operation disables its rules and audits this.
- An operation without a group row is not reachable (`group_missing`).
- A group can go to `write` only with the exact list of writes that it acknowledges. A list that is not current returns 409.
- Only the Admin API changes levels, and core audits each change. Only the approval page makes approval decisions (§5.3).
- Sandbox code and plugin children have no access to any of these tables.
