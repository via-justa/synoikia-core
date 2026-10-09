# Data and state

## The HTTP client

All calls go through `http` in `src/api.ts`. It sends the CSRF header on writes, throws `ApiError` (status, code, details) on failure and sends a 401 back to the login page. Don't call `fetch` elsewhere. Build query strings with `qs()`. Turn any error into UI text with `errorText()`.

## Server state: vue-query

`@tanstack/vue-query` owns all server data. One `QueryClient` is created in `main.ts` with the defaults; don't repeat them per query:

- `staleTime: 30_000`, `refetchOnWindowFocus: false`.
- Retry once, and never on an `ApiError` with a 4xx status (a 403 or 404 won't change on retry).

### Query composables

Each API area has one composable file in `src/composables/` (`useRoles.ts`, `useInstances.ts`, …) that exports its queries and mutations. Views and components consume them; they don't call `http` themselves.

```ts
export const roleKeys = { all: ['roles'] as const };

export function useRolesQuery() {
  return useQuery({ queryKey: roleKeys.all, queryFn: () => http.get<RoleRow[]>('/api/roles') });
}
```

- **Query keys mirror the API path** after `/api`, one segment per element: `['roles']`, `['instances', slug, 'operations']`, `['me', 'endpoints']`. Then invalidating a prefix refreshes everything under it. Export the keys from the composable file; don't write a key literal in a view.
- A query that depends on a route param takes a `MaybeRefOrGetter` and uses `toValue` in the key and the function, with `enabled` when the param can be empty.
- Read data from the query (`data`, `isPending`, `error`). Never copy it into a `ref` or a store. For a draft the user edits, copy once into a local `ref` and reset it from the query after a save.

### Mutations

Writes go through the shared mutation composable in `src/composables/`, not raw `useMutation`. It takes the call and the keys to invalidate, and exposes the error as text through `errorText`. This replaces the per-view `try { … } catch (err) { error.value = errorText(err) }` blocks: one place handles errors and cache refresh.

- Invalidate the narrowest prefix that covers the change.
- Call `mutate()` from handlers. Use `mutateAsync()` only when the next step needs the result (for example, navigate to a new resource).
- A form's submit handler calls a mutation; it never calls `http` directly.

## Live events

The admin listener streams core events on `/api/events` (SSE). One place opens the `EventSource` for admins and maps each event name to the query keys it invalidates. Pages don't open their own stream. A page that must react beyond a refresh subscribes through the same place and unsubscribes on unmount.

### Clear the cache when the user changes

The cache holds what the signed-in user may see. Clear it (`queryClient.clear()`) whenever the session user changes: sign-out, a 401 that ends the session, or a different user signing in on the same tab. Do it in one place that watches the session store's user, not in each view. Otherwise one user's data can show to the next. Keep a test that fails without it.

## Client state: Pinia

Pinia holds only app-wide state that the server doesn't own: the session (who is signed in, role, login flow) and the live-event connection. Use setup stores:

```ts
export const useSessionStore = defineStore('session', () => {
  const user = ref<PublicUser>();
  const isAdmin = computed(() => user.value?.role.isAdmin ?? false);
  async function load() { … }
  return { user, isAdmin, load };
});
```

Component-local state stays in the component. Browser preferences (the theme) use `localStorage` under a `synoikia.` key, wrapped in `try`/`catch` as `theme.ts` does. Never put secrets or tokens in storage.

## Router

`src/router.ts` declares routes with `meta.public`, `meta.admin` and `meta.title`. The guard loads the session once, then handles setup, login, TOTP enrollment and the admin check. The admin check is for navigation only; the API refuses the call anyway (design §6.4). Add a page by adding a route with the right `meta`, not a check inside the view.
