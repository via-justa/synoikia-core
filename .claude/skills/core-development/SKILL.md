---
name: core-development
description: >-
  How to write and review backend code in Synoikia core — packages/core, packages/plugin-sdk and
  packages/create-plugin. Use it for any task that changes or reviews their TypeScript or tests, even when the
  request names only a feature, a bug or an endpoint and never says "TypeScript" or "backend". Examples: add or
  change an Admin API or MCP route; add a service method, a setting, an event or an error code; make a limit
  configurable; fix a bug in the gate, sandbox, approvals, auth, audit, catalog sync, plugin host or
  notifications; change the plugin SDK, its RPC contract or create-plugin templates; write or fix core tests;
  review a backend diff. Use it alongside db-migration when a schema change also needs code. Not for the admin
  UI (.vue files and packages/admin-ui use vue-development), docs-only edits to docs/design, CI or Dockerfile-only
  changes, or plugin repos outside this one.
---

# Core development

Core is a Node 22 ESM server: Hono for HTTP, Drizzle on SQLite, isolated-vm for the sandbox, zod at every boundary. New code must look like the code around it. The priorities are simplicity, reuse and efficiency: one shared way to do each thing, the smallest change that does the job, and no new dependency for what a few lines already do.

`CLAUDE.md` holds the repo rules (security lives in core, versions, design doc, security review). This skill is how to write the code. Load a reference only when the task touches its area:

| Task touches                                                                          | Read                              |
| ------------------------------------------------------------------------------------- | --------------------------------- |
| A service, a route, errors, audit, settings, events, logging, time, secrets           | `references/services-and-http.md` |
| Types, zod, Drizzle types, narrowing, error and result shapes, imports, module layout | `references/typescript.md`        |
| Writing or reviewing tests                                                            | `references/testing.md`           |

## Rules for every change

1. **Reuse first.** Before writing a helper, look in the module you're in, `http/common.ts` (`readJson`, `clientIp`, `errorResponse`), `errors.ts`, `audit.ts`, `settings.ts`, `lenient.ts`, `log.ts`, `crypto/` and `test/helpers.ts`. Use it, or extend it. A second copy of a helper is a defect.
2. **Layers stay thin and in order.** A route reads and validates input, calls one service method, and returns its result. Business rules, checks and audit live in the service. Pure decisions (the gate, matching, redaction) are plain functions with no I/O.
3. **Validate at the edge, trust inside.** Request bodies, env, stored JSON, plugin messages and upstream data are parsed with zod (or the existing ajv path for plugin config schemas). Past that point, use the inferred types; don't re-check.
4. **Errors are `ServiceError` subclasses** (`ValidationError`, `NotFoundError`, `ConflictError`, `ForbiddenError`) with a stable snake_case `code`. `errorResponse` turns them into JSON; anything else is a 500 that leaks nothing.
5. **Every change of state is audited** with `writeAudit` in the same transaction as the write.
6. **Security lives in core, once.** Don't add a check, flag or redaction step outside the module that owns it (`gate/`, `sandbox/`, `auth/`, `approvals/`, `gate/redact.ts`). Read that module's `README.md` before changing it. Never log, return or audit a secret.
7. **A configurable security limit can't loosen what the task didn't name.** Lockouts, rate limits, timeouts, expiries and size caps protect a surface, and the MCP port faces the internet while the admin port may not. Scope a new setting to the surface the task names, keep the others on their current value, and say so. Default to today's value and bound it with a safe minimum and maximum.
8. **Plugin-agnostic.** No plugin names in code, tests or messages; tests use the `echo` fixture and neutral slugs (`acme`).
9. **Published APIs are contracts.** `@synoikia/plugin-sdk` and `@synoikia/core/testing` are used by every plugin repo. Don't change an exported signature unless the task asks for it, and call out a breaking change. SDK `rules.ts`, `http-client.ts`, `openapi.ts` and `static-catalog.ts` are security code.
10. **Small and direct.** No speculative options, base classes, generic wrappers or config for one caller. Comments are one or two lines, for a reason or a `§` reference only.
11. **Tests ship with the change** (see `references/testing.md`), and the design doc section changes with the behavior.

## Checks

Run from the repo root before finishing:

```sh
pnpm lint && pnpm format:check && pnpm typecheck
pnpm --filter @synoikia/core exec vitest run test/<file>.test.ts   # the files you touched, then the package
pnpm --filter @synoikia/core test:coverage                          # when gate/, auth/, approvals/, sandbox/ or crypto/ changed
```

Then run the `security-reviewer` subagent when `CLAUDE.md` "Security review" lists a path you touched, and bump versions as "Releases" says.

## Reviewing

Lead with what tools can't catch: logic in a route instead of a service, a write without its audit row, a check added outside the module that owns it, a hand-rolled copy of an existing helper, a secret that reaches a log, response or audit row, unvalidated input crossing a boundary, an `as` cast hiding a real type gap, a missing test for the failure path. Say why each matters.
