# Testing

Tests live in `packages/admin-ui/test/*.test.ts` and run with Vitest in jsdom (`pnpm --filter @synoikia/admin-ui test`). New or changed behavior ships with a test in the same change.

## The harness (`test/helpers.ts`)

- **`fakeApi(routes)`** stubs `fetch` at the HTTP boundary. Keys are `'METHOD /path'` (with or without the query string); a value is a JSON body, a `Response`, or a handler `(body, url) => …`. Unmatched calls return 404. It returns the recorded `calls` to assert on. Never mock `http`, a store or a composable instead.
- **`mountAt(path)`** mounts the real `App` with a fresh Pinia and the real router on memory history, so guards, layouts and route params run as in the browser. It returns `{ wrapper, router }`.
- **Fixtures:** `signedIn` and `adminRole`. Add shared fixtures there, typed from `src/types.ts`, rather than in each file.
- With vue-query, `mountAt` installs a fresh `QueryClient` per test with retries off, never the app's client.
- Reset in `afterEach`: `vi.unstubAllGlobals()`, `vi.restoreAllMocks()`, `document.body.innerHTML = ''`.

## Patterns

- **A page:** `fakeApi` with the session and the page's endpoints, `mountAt('/the/path')`, act, `await flushPromises()`, then assert on the DOM and on `calls` (method, path, body).
- **A component alone:** `mount(Component, { props })` when it needs no router or store (see the `SchemaForm` tests).
- **Pure helpers** (`format.ts`, `MarkdownLite`): import and assert directly.
- **Guards:** mount at a path and assert `router.currentRoute.value`.

## Rules

- Find elements the way a user does: by role attributes, label text, button text or visible text. Avoid selectors on internal classes or component internals.
- Assert what the user sees and what was sent to the API, not refs or store fields.
- `mountAt` attaches to `document.body`; query `document.body` for anything rendered outside the wrapper.
- Cover the error path: make the fake return an error and assert the `role="alert"` message.
- No plugin names in fixtures; use neutral ones (`acme`, `nas`).
