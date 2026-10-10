# Synoikia core

One MCP server for many self-hosted services. Each plugin instance gets its own endpoint exposing `search(code)`, `execute(code)` and `resume(executionId)` (for a call parked on an approval), and every call goes through one sandbox, permission gate, approval flow, redaction and audit log. The software design description (SDD) is in `docs/design/`, one file per section; code comments cite its sections (`§5.2`).

**The rule everything follows: security lives in core, once.** A plugin only describes its upstream API; it never decides what is allowed. Don't add a plugin-side switch for anything the gate, sandbox, approvals, redaction or auth already decide. Core stays plugin-agnostic: no plugin names (TrueNAS, Seerr, Home Assistant) in core code, tests or UI placeholders. The plugins live in `via-justa/synoikia-core-plugins`.

## Layout

| Path                        | What                                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core`             | Server: MCP endpoints, admin API, gate, sandbox, plugin host, SQLite (Drizzle)                                                                                                                                     |
| `packages/plugin-sdk`       | Manifest schema, core ⇄ plugin RPC contract, `runPlugin()`, and what plugins are built from: `definePlugin`, the `plugin.yaml` rules engine, HTTP/socket transports, OpenAPI and static catalogs. Published to npm |
| `packages/create-plugin`    | `@synoikia/create-plugin`: `pnpm create`/`pnpm new` scaffolding, plugin build/check, signed repository release. Published to npm                                                                                   |
| `packages/admin-ui`         | Admin portal: Vue 3, Pinia, Vite                                                                                                                                                                                   |
| `packages/core/src/testing` | `@synoikia/core/testing`: the plugin harness, `startFakeHttp` and `checkPluginContract` plugin repos test against. Published API                                                                                   |

Plugin authoring: `docs/plugin-authoring.md`. SDK code is bundled into every plugin, so `rules.ts`, `http-client.ts`, `openapi.ts` and `static-catalog.ts` decide what plugins tell core: treat changes there as security changes. `create-plugin` templates use only published SDK and core APIs and are smoke-tested by `packages/create-plugin/test/smoke.test.ts`.

Each security-critical directory under `packages/core/src` (`gate/`, `sandbox/`, `plugins/`, `auth/`) has a short `README.md` with its pipeline and design sections. Read it before changing that module.

Admin UI work (any `.vue` file or `packages/admin-ui`) follows the `vue-development` skill (`.claude/skills/vue-development/`): vue-query for server state, Pinia setup stores for the session only, shared composables, `styles.css` tokens, `ModalDialog` over native dialogs. Load it before writing or reviewing portal code.

Backend work (`packages/core`, `packages/plugin-sdk`, `packages/create-plugin`) follows the `core-development` skill (`.claude/skills/core-development/`): thin Hono routes over services, zod at every boundary, `ServiceError` codes, audit in the write's transaction, reuse of the shared helpers. Load it before writing or reviewing backend code.

## Commands

Node 22.12+ or 24 (`.nvmrc` pins 22), pnpm 10.

```sh
pnpm lint && pnpm format:check && pnpm typecheck && pnpm build && pnpm test   # what CI runs, in that order
pnpm --filter @synoikia/core exec vitest run test/gate.test.ts                # one test file
pnpm --filter @synoikia/core test:coverage                                      # enforces coverage floors
pnpm format                                                                     # fix formatting
```

- Tests resolve workspace packages to their TypeScript sources (the `synoikia-source` export condition), so no build is needed before `pnpm test`.
- `isolated-vm` needs `--no-node-snapshot`; the vitest config and `pnpm start` already pass it. Any new way of running core must too.
- `packages/core/vitest.config.ts` sets coverage floors for `gate/`, `auth/`, `approvals/`, `sandbox/` and `crypto/`. A change there comes with tests that keep coverage above them.

## Conventions

- TypeScript is strict with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`: use `import type` for types, and `.js` extensions on relative imports.
- Unused variables are allowed only with a `_` prefix.
- Keep comments minimal: one or two lines, only for what the code can't say (a reason, a constraint, a design § reference). No multi-line comment blocks, in code, YAML, SQL or workflows; the design doc and READMEs carry the long explanations.
- Prettier formats everything (a hook runs it after each edit). Template layout in `.vue` files is Prettier's job, not ESLint's.
- Keep changes focused, add tests for new behavior, and update the README or design doc when behavior changes (see `.github/PULL_REQUEST_TEMPLATE.md`).

## Design documents

`docs/design/` is the SDD of core. `docs/design/README.md` is its index, rules and glossary. When behavior changes, update the section it belongs to in the same PR.

- Write in ASD-STE100 Simplified Technical English: short sentences (20 words at most for procedures, 25 for descriptions), active voice, simple tenses, one statement per sentence, and the glossary's terms only, each with one meaning.
- Describe the current design only. No history: no earlier, reverted or revised designs, no "this replaces", "used to" or migration notes. Those belong in commit messages and PRs.
- Keep section numbers stable: code comments cite them. A new subsection takes a new number; never renumber or reuse one.
- State facts that the code confirms. If the code and the SDD disagree, find out which one is wrong before you edit either.
- Simplify: tables and lists over long paragraphs, and no rationale beyond what a reader needs to keep the design intact.

## Database

Schema is `packages/core/src/db/schema.ts`. Migrations in `packages/core/drizzle/` are generated with `pnpm --filter @synoikia/core db:generate` and applied on startup. Never hand-edit `drizzle/meta/`, and never change a migration that has shipped. A data migration is appended to the newly generated `.sql` file and tested in `packages/core/test/migrations.test.ts`. The `db-migration` skill walks through it.

## Releases

`@synoikia/plugin-sdk`, `@synoikia/core` and `@synoikia/create-plugin` publish to npm when their `version` changes on `main`. The Docker image uses the root `package.json` version, separate from the package versions.

A PR bumps the version of each published package, and of the image, whose shipped content it changes, in the same PR. Docs-, test- and CI-only changes bump nothing.

- Semver, while 0.x: a breaking change or a new feature bumps the minor; a fix bumps the patch.
- `@synoikia/core`: changes under `packages/core/src` (including `testing/`) or its runtime dependencies.
- `@synoikia/plugin-sdk`: changes under `packages/plugin-sdk/src` or its dependencies.
- `@synoikia/create-plugin`: its own changes, and a patch whenever core or the SDK takes a minor bump (its `workspace:^` ranges are packed with the minor pinned).
- Root `package.json` (the image): anything the image ships (core, admin UI, `Dockerfile`, image dependencies), by the same step as the largest package bump.
- Name the new versions in the PR title, e.g. "(core 0.7.0, image 0.5.0)".

A breaking change to the SDK or `@synoikia/core/testing` breaks every plugin repo, so call it out.

## Security review

Before opening a PR that touches `gate/`, `sandbox/`, `approvals/`, `auth/`, `crypto/`, `plugins/`, `http/`, `runtime/`, `instances/`, the SDK's RPC contract or its rules, transports and catalog adapters, `packages/create-plugin`, the DB schema, a `package.json` or the `Dockerfile`, run the `security-reviewer` subagent (`.claude/agents/security-reviewer.md`) on the diff and address its findings. It also runs `pnpm audit` and triages known CVEs by whether the vulnerable dependency ships and is reachable.

## Protected files

A PreToolUse hook (`.claude/hooks/guard-paths.mjs`) denies edits to `drizzle/meta/` and `pnpm-lock.yaml`, and asks first for migration SQL and `packages/core/src/plugins/default-repo.ts`. That file pins the plugin repository's signing key, and changing it makes every install block plugin installs until an admin confirms the new key.
