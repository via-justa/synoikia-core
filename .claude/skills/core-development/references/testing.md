# Testing

Vitest, one `test/` directory per package (`packages/core/test/*.test.ts`, `packages/plugin-sdk/test/`, `packages/create-plugin/test/`). Tests import workspace packages from their TypeScript sources, so no build is needed. New or changed behavior ships with a test in the same change, including the failure path.

## Pick the smallest level that proves the behavior

| What                                                                   | How                                                                                    |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| A pure function (gate decision, matcher, redaction, formatter, parser) | Import and call it directly (see `gate-pure.test.ts`)                                  |
| A service against the database                                         | `openDatabase(':memory:')` plus `seedInstance`, `op`, `catalog` from `test/helpers.ts` |
| A route, auth, CSRF, roles, the full call path                         | `createTestApp` + `createAdminApp(ctx)` + `browser(app)` from `test/admin-client.ts`   |
| A plugin process end to end                                            | the `echo` fixture plugin (`test/fixtures/plugins/echo`) through `createTestApp`       |

## The shared harness

- **`createTestApp({ DATA_DIR }, { memoryDb: true })`** builds a real `AppContext` with the fixture plugins installed and enabled. Give it a fresh `mkdtempSync` directory.
- **`browser(app)`** is a cookie-keeping client for `app.request()` that echoes the CSRF token: `await browser(app).init()`, then `.post('/api/setup', …)`, `.get(…)`. Use it for every Admin API test; don't hand-build cookies or headers.
- **Cleanup stack:** push `ctx.stop()` and the directory removal onto a `cleanup` array and drain it in `afterEach`, as `roles.test.ts` does.
- **Time:** pass `now` through `AppOptions` (or the service constructor) instead of faking timers when the code takes `now`.
- **Network:** `startFakeHttp` from `@synoikia/core/testing` for an upstream; never reach the real network.
- Add a helper to `test/helpers.ts` when a second test file needs it, not before.

## Rules

- Assert on behavior a caller sees: the HTTP status, the error `code`, the response body, the audit row, the emitted event. Not on private fields.
- Every new error path gets a test that hits it and checks its `code`.
- A security check gets a test that proves it refuses (wrong role, missing CSRF, expired grant), not only one that proves it allows.
- Keep coverage above the floors in `packages/core/vitest.config.ts` for `gate/`, `auth/`, `approvals/`, `sandbox/` and `crypto/` (`pnpm --filter @synoikia/core test:coverage`).
- `@synoikia/core/testing` is published: a change to it gets a test in `testing-*.test.ts`.
- SDK changes get tests in `packages/plugin-sdk/test/`; a template change in `create-plugin` must keep `smoke.test.ts` passing.
- No plugin names in fixtures or assertions.
