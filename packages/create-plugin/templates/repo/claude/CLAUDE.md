# {{repoName}}

Plugins for [Synoikia](https://github.com/via-justa/synoikia-core). Authoring guide: `https://github.com/via-justa/synoikia-core/blob/main/docs/plugin-authoring.md`.

**A plugin only describes its upstream API; core decides what is allowed.** Core's sandbox, permission gate, approvals, redaction and audit apply to every plugin. A plugin supplies the catalog, the classification (read, write, locked), targets, summaries, confirmation literals and `sensitiveKeys`. It never adds its own allow/deny switch, approval prompt or secret handling.

## Layout

| Path                         | What                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `plugins/<id>/manifest.json` | Validated by the SDK schema: binding, connection form, `sensitiveKeys`, network hosts      |
| `plugins/<id>/plugin.yaml`   | Policy as data: locked operations, split twins, sensitive params/results, confirm literals |
| `plugins/<id>/src/`          | `index.ts` calls `runPlugin()`; `plugin.ts` holds discovery and logic; `auth.ts` the auth  |
| `plugins/<id>/test/`         | A fake upstream, unit tests, and `e2e.test.ts` on core's harness                           |

Policy data (locks, splits, sensitive params and results, confirm literals, guidance) goes in `plugin.yaml`; only decisions that need logic go in `src/`. `plugin.yaml` is validated and inlined at build time, so rebuild before e2e tests.

## Commands

Node 22.12+, pnpm 10.

```sh
pnpm new                                   # add a plugin (see the add-plugin skill)
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test   # what CI runs
pnpm --filter ./plugins/<id> test          # one plugin: check, build, unit + e2e
pnpm check                                 # manifests, plugin.yaml and versions
```

## Rules that break releases or installs

- **Self-contained bundle.** The plugin reads nothing outside its own package directory at runtime; `synoikia-plugin build` bundles every dependency and data file.
- **Network hosts.** `manifest.json` `network.hosts` lists exactly the hosts the plugin connects to. Admins review it before enabling the plugin, and an update that changes it installs disabled. Core doesn't enforce it (the plugin process can reach any host), so it must be accurate.
- **Secrets.** Every credential field is `writeOnly: true`, uses the `secret` widget and is in `sensitiveKeys`, along with every secret field the upstream returns. `synoikia-plugin check` enforces the first part; an e2e `secrets` contract check covers the second.
- **Versions.** `version` in `manifest.json` and `package.json` must match, and a released version never changes. Bump only when asked; the `release-plugin` skill covers it.

## Security review

Before opening a PR that touches a plugin's `manifest.json`, `plugin.yaml`, `src/` or dependencies, or `.github/workflows/`, run the `security-reviewer` subagent on the diff and address its findings.
