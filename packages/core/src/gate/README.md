# gate/

Permission gate: resolveOperation → attestation → access (group level + per-op exclusions, locked
opt-in, write acknowledgement; `access.ts`) → target resolution → prepareWrite → classification →
pre-approval → human approval → invoke → redact (the operation's `sensitiveResult` on the raw result,
then sensitive keys and secret values; `redact.ts`) → audit.

Design: [`docs/design/05-call-path.md`](../../../../docs/design/05-call-path.md) §5.2–§5.3, §5.5.
