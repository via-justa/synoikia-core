# Services, routes and shared infrastructure

## Wiring

`createAppContext` in `src/app.ts` builds every service once and returns `AppContext` (`ctx`). Routes, the scheduler and tests all take `ctx`. A new service is constructed there, added to `AppContext`, and takes only what it uses (`db`, `events`, `secrets`, `now`, `log`). No module-level singletons.

## Services

A service is a class in its module (`auth/roles.ts`, `approvals/service.ts`, `instances/manager.ts`) when it holds state or several collaborators; otherwise a module exports plain functions that take `db` first (`catalog/groups.ts`, `catalog/rules.ts`, `settings.ts`). Follow the shape the module already has.

```ts
create(raw: unknown, actor: { userId?: string } = {}): PublicRole {
  const input = RoleInput.parse(raw);
  const id = randomUUID();
  this.db.transaction((tx) => {
    if (tx.select({ id: roles.id }).from(roles).where(eq(roles.name, input.name)).get())
      throw new ConflictError('role_name_taken', 'A role with that name exists');
    tx.insert(roles).values({ id, ...input, createdAt: new Date() }).run();
    writeAudit(tx, { kind: 'config', decision: 'role_created', actorKind: 'user', actorId: actor.userId, detail: { id, ...input } });
  });
  return toPublicRole(this.get(id));
}
```

- Mutations take the raw input and parse it with the module's zod schema, so every caller (route, CLI, test) gets the same validation. The schema lives next to the service; `Input.partial()` serves updates.
- Mutations take an `actor` and write the audit row with it.
- Checks and writes that must agree run in one `db.transaction`. Functions that can run inside one take `db: DbLike = this.db`.
- `get(id)` throws `NotFoundError`; callers don't re-check for `undefined`.
- Return a public shape (`toPublicRole`), never a raw row with secret or internal columns.
- SQLite via better-sqlite3 is synchronous: Drizzle calls end in `.get()`, `.all()` or `.run()`. Keep a service method sync unless it awaits real I/O (a plugin call, the network, the file system).

## Routes (Hono)

Routes live in `src/http/admin/*.ts` (`register<Area>Routes(app, ctx)`) and `src/http/mcp/`. `admin-app.ts` mounts them after CSRF, sign-in and admin middleware: every `/api` route is admin-only unless its path is in `EVERY_USER`. Add a route to the matching register function, not a new middleware stack.

```ts
app.patch('/api/roles/:id', async (c) => {
  const body = await readJson(c, z.object({ name: z.string().optional() }));
  return c.json(ctx.roles.update(c.req.param('id'), body, actor(c)));
});
```

- Read bodies with `readJson` / `readOptionalJson` from `http/common.ts`. Malformed JSON and zod failures become 400s through `errorResponse`.
- Return `c.json(result)`, `c.json(result, 201)` for a create, `c.body(null, 204)` for a delete.
- Don't catch errors in a route; `app.onError(errorResponse)` maps them. Throw a `ServiceError` subclass for a client error.
- A non-admin route scopes every query to the caller (`c.get('user')`, their role). The UI hiding a button is not access control.
- Rate-limit anything that lets a caller probe other hosts or guess credentials with `ctx.throttle` or `ctx.limiter`, as `connection/test` does.
- Get the client IP with `clientIp(c, ctx.config.TRUST_PROXY)`, never from a header directly.

## Errors

`src/errors.ts`: `ValidationError` (400), `ForbiddenError` (403), `NotFoundError` (404), `ConflictError` (409), all `ServiceError`. The `code` is stable snake_case (`role_name_taken`) and the UI and tests key on it; the message is a short sentence for a person. Put structured extras in `details`. A module error that isn't an HTTP error (`PluginRpcError`, `DecryptionError`) extends `Error` in its module, and `errorResponse` maps it if a route can see it.

## Audit

`writeAudit(dbOrTx, event)` from `src/audit.ts`, inside the write's transaction. `kind` and `decision` name what happened (`role_created`); `detail` holds the non-secret inputs. The audit log is append-only: never update or delete rows outside housekeeping.

## Settings

Global settings are zod schemas in `src/settings.ts` (`SETTINGS_SCHEMAS`), one JSON document per section. Read with `getSettings(db, section)`, write with `updateSettings`. A new setting is a field with a `.default()` in its section schema, so stored documents from older releases still parse. Stored JSON from an earlier release is read with `parseLeniently` (`src/lenient.ts`); request input is parsed strictly.

## Events

`CoreEvents` (`src/events.ts`) is a typed in-process bus for notifiers and the admin SSE stream. A new event adds its payload to `CoreEventMap` and its name to `CORE_EVENT_NAMES`. Payloads never carry call parameters or secrets.

## Logging

Use the `Logger` from `ctx.log` (`src/log.ts`): a constant message plus fields, `ctx.log.warn('sync failed', { slug, error: err.message })`. It quotes client-supplied values so they can't forge log lines. Don't use `console.*` in new code (some older modules still do), and never log a credential, token or secret value.

## Time

Code whose behavior depends on time (expiry, throttles, sessions, approvals, housekeeping) takes `now: () => Date` from `ctx.now` so tests control it. A plain timestamp on an inserted row may use `new Date()`.

## Secrets

Secrets are stored encrypted with `ctx.secrets` (`SecretBox`, `crypto/index.ts`) and bound to their row with `aad(table, column, rowId)`. Decrypt only where the value is used (the plugin host passing credentials), never into a response, log, event or audit row. Redaction of call results happens once in `gate/redact.ts`.
