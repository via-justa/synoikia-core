---
name: vue-development
description: Write and review Vue 3 + TypeScript code in the admin UI (packages/admin-ui). Use whenever a change touches a .vue file or anything under packages/admin-ui/src or packages/admin-ui/test (views, components, composables, stores, router, api.ts, styles.css), when fetching data or submitting forms in the portal, styling it, writing its tests, or reviewing whether portal code is idiomatic. Not for core, the SDK or create-plugin.
---

# Vue development (admin UI)

The admin UI is a Vue 3 + TypeScript + Vite SPA served by core's admin listener. New code must look like the code around it. The priorities are simplicity, reuse and efficiency: one shared way to do each thing, no new dependency for what a few lines already do.

## Where the code is today

The skill describes the target. Much of the admin UI predates it, and a refactor will move it over. Until then:

- **Shared pieces:** when a task needs one that doesn't exist yet (the `src/composables/` folder, the confirm composable, a query composable for an area), create it in the shape this skill describes and use it. Don't fall back to the old per-view pattern because the shared piece is missing.
- **vue-query:** a page moves to vue-query only in the migration work, or when the task is to migrate it. A small change to a page that still loads with `http` into refs keeps that pattern, so the page stays consistent and the lockfile is untouched. Once `@tanstack/vue-query` is installed and a page is migrated, every change to that page uses it.
- **Other gaps** (a literal color, a native dialog, an untyped prop) in code you touch: fix them when they are in the lines you change; otherwise leave them and mention them in the PR.

Load a reference only when the task touches its area:

| Task touches                                                                     | Read                                   |
| -------------------------------------------------------------------------------- | -------------------------------------- |
| Fetching or changing data, vue-query, query keys, live events, Pinia, the router | `references/data-and-state.md`         |
| Components, composables, forms, dialogs, styling, accessibility                  | `references/components-and-styling.md` |
| Writing or reviewing tests                                                       | `references/testing.md`                |

## The stack

- **Vue 3**, always `<script setup lang="ts">` and the Composition API.
- **Server state:** `@tanstack/vue-query` over the `http` client in `src/api.ts`. Server data never lives in a `ref` or a store. The cache is cleared when the signed-in user changes.
- **Client state:** Pinia setup stores, only for what is app-wide and not server-owned (the session and the live-event stream).
- **Forms:** plain `v-model`. Core validates; the UI shows its message with `errorText`.
- **Styling:** the design tokens and global classes in `src/styles.css`, plus scoped `<style>`. No UI kit, no CSS framework.
- **Dialogs:** `ModalDialog`, never `window.confirm` or `window.prompt`.
- **Layout:** flat. `views/` (routed pages, `views/instance/`, `views/settings/`), `components/` (shared UI), `composables/` (shared `use*` logic), `stores/`, `layouts/`, plus `api.ts`, `types.ts`, `format.ts`, `theme.ts`.

## Rules for every change

1. **One way per concern.** Before writing logic, look in `composables/`, `api.ts`, `format.ts` and `components/`. Reuse it, or extract it there when a second caller appears. Don't copy a block between views.
2. **Typed contracts.** Type-based `defineProps<{…}>()`, `defineEmits<{…}>()` and `defineModel<T>()`. API shapes come from `src/types.ts`; don't redeclare them. No `any`.
3. **Every async state is rendered.** Loading, empty, error and success are each visible. Errors use `<p class="alert error" role="alert">`; notices use `<p class="alert ok" role="status">`.
4. **Tokens, not values.** Components use `var(--token)` and the global classes. No hex, `rgb()` or named colors in a component; a new value becomes a token in `styles.css` for both themes.
5. **Core decides security.** The UI hides what the role can't do, but the API is the authority. No secrets or tokens in `localStorage` (the session is a cookie; `http` sends the CSRF header). No `v-html`; render help text with `MarkdownLite`.
6. **Plugin-agnostic.** No plugin names in code, tests or placeholders. Plugin wording comes from the API (for example `plugin.labels`).
7. **Tests ship with the change** (see `references/testing.md`).

## Checks

Run from the repo root before finishing; these are the CI gates:

```sh
pnpm lint && pnpm format:check
pnpm --filter @synoikia/admin-ui typecheck
pnpm --filter @synoikia/admin-ui test
```

## Reviewing

Lead with what tools can't catch: server data in a ref or store instead of a query, logic duplicated instead of reused, an unhandled loading/empty/error state, untyped props or emits, a native dialog, a literal color, a control that the keyboard can't reach. Say why each matters.
