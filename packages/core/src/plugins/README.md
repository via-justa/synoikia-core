# plugins/

Plugin host: discovery (core `plugins/*` + `DATA_DIR/plugins`), manifest validation, repo index
fetch + sha256/signature verification, child-process spawn with the Node permission model, JSON-RPC
over IPC, crash supervision, catalog/registry sync.

Design: [`docs/design/`](../../../../docs/design/README.md) §3, §4, §10.
