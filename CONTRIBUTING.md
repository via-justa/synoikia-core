# Contributing to Synoikia

Thanks for taking the time to contribute. Bug reports, feature requests and pull requests are all welcome.

## Development setup

Requires [Node.js](https://nodejs.org/) 22 (≥ 22.12) or 24 and [pnpm](https://pnpm.io/) 10 (`corepack enable`).

```sh
pnpm install
pnpm test        # all packages (workspace deps resolve to TS sources, no build needed)
pnpm typecheck
pnpm lint
pnpm build
DATA_DIR=./data pnpm start   # MCP on :8080, admin on :8081; creates ./data/synoikia.sqlite + master.key
```

Admin UI with hot reload: run `pnpm start` in one shell and `pnpm --filter @synoikia/admin-ui dev` in another. [Vite](https://vite.dev/) proxies `/api` and `/auth` to `:8081`.

DB schema changes: edit `packages/core/src/db/schema.ts`, then `pnpm --filter @synoikia/core db:generate` ([Drizzle Kit](https://orm.drizzle.team/docs/kit-overview)).

For the architecture and design rationale behind core, the sandbox, the permission gate and the plugin protocol, see the software design description in [`docs/design/`](docs/design/README.md).

## Before opening a pull request

CI (`.github/workflows/ci.yml`) runs `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm build` and `pnpm test`, plus a Docker build. Run the same commands locally first:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check   # pnpm format to fix
pnpm typecheck
pnpm build
pnpm test
```

Keep changes focused: a bug fix doesn't need an accompanying refactor, and a new feature should come with tests covering it. Match the existing code style rather than introducing a new pattern for something already established elsewhere in the codebase.

## Releases

This repo publishes two npm packages (`@synoikia/plugin-sdk`, `@synoikia/core`) and a Docker image, each versioned independently — see the README's [Publishing the plugin packages](README.md#publishing-the-plugin-packages) and [Publishing the Docker image](README.md#publishing-the-docker-image) sections. As a contributor you generally don't need to touch versions or releases yourself; a maintainer bumps the relevant `version` field when a change is ready to ship.

## Code of Conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you're expected to uphold it.

## Reporting security issues

Please do not open a public issue for a security vulnerability — see [SECURITY.md](SECURITY.md) instead.
