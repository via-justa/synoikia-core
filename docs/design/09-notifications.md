# §9 Notifications

Notifications give information only. They never carry links to approve or deny a call. Approvals happen in the MCP client, which opens the approval page (§5.3).

## 9.1 Channels

| Kind      | Configuration                                                                    | Delivery                                                                                                                                                                                                                    |
| --------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ntfy`    | Server URL (default `https://ntfy.sh`), topic, optional access token (encrypted) | JSON publish to `POST {server}` with `topic`, `title`, `message`, `priority`, `tags`. JSON keeps titles safe for UTF-8.                                                                                                     |
| `webhook` | URL, optional HMAC secret (encrypted), optional extra headers (encrypted)        | `POST` JSON `{event, at, instance, title, message, data}` with `X-Synoikia-Event`, `X-Synoikia-Timestamp` and `X-Synoikia-Signature: sha256=<HMAC-SHA256(secret, timestamp + "." + body)>`. A receiver can refuse a replay. |

Each channel subscribes to a set of events, and can have a filter for instances.

| Event                 | When                                                                               |
| --------------------- | ---------------------------------------------------------------------------------- |
| `instance.error`      | An instance goes to `error`.                                                       |
| `instance.recovered`  | An instance comes back from `error`.                                               |
| `plugin.crashed`      | A plugin child crashes.                                                            |
| `sync.failed`         | A catalog sync fails.                                                              |
| `sync.pending_review` | A sync adds or changes writes, or disables rules (§5.2.1).                         |
| `auth.lockout`        | A user name reaches the failure limit (§6.1). Core sends it once for each lockout. |

- Core sends a message up to 3 times with backoff. It does not send again after a 4xx answer, except 429.
- A failure sets `last_error`, which Settings → Notifications shows. Each channel has a Test button.
- Messages use the redacted summary. They never hold raw parameters.
- Core removes event names that are no longer valid when it reads or saves a channel.
