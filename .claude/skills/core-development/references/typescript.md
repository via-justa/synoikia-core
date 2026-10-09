# TypeScript

The compiler settings are in `tsconfig.base.json`: strict, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, `NodeNext` modules, `exactOptionalPropertyTypes` off. Don't change them per package.

## Imports and modules

- `import type` for anything used only as a type; `.js` extension on every relative import.
- Relative paths only. No path aliases, and no `index.ts` that only re-exports: `index.ts` is a module's real entry point (`db/index.ts`, `sandbox/index.ts`, `crypto/index.ts`).
- Group code by the module that owns the concern (`gate/`, `auth/`, `catalog/`), not by kind of file. A file grows until it holds one concern; split it when a second concern appears, not before.
- Node built-ins with the `node:` prefix.

## Types come from one source

- Request, settings, env and message shapes: a zod schema, and `z.infer<typeof Schema>` for the type. Don't write an interface that repeats a schema.
- Rows: Drizzle's `typeof table.$inferSelect` / `$inferInsert`.
- Fixed sets of values: an `as const` array and a union derived from it, never an `enum`. The array also feeds `z.enum`:

  ```ts
  export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
  export type LogLevel = (typeof LOG_LEVELS)[number];
  ```

- Plugin-facing types come from `@synoikia/plugin-sdk`; core doesn't redeclare them.

## Narrow, don't cast

- `unknown` for anything not yet validated; parse or narrow it. No `any`.
- Avoid `as`. When a cast is needed (a JSON column, a library gap), keep it at the boundary and next to the check that makes it true. `x!` is fine only right after a check or for a test fixture.
- `satisfies` to check an object literal against a type without widening it.
- With `noUncheckedIndexedAccess`, handle the `undefined` from `arr[i]` and `record[key]` (`?.`, `??`, an early return) rather than asserting it away.

## Errors and results

- Throw for failures: a `ServiceError` subclass for client errors, a module `Error` subclass for internal ones. Error classes set `this.name` (`new.target.name` in a base class, as `ServiceError` does).
- Return a discriminated union (`{ ok: true; … } | { ok: false; reason: … }`) for an expected outcome the caller branches on, such as a gate decision or a match. Don't add a generic `Result<T, E>` type or library.
- `catch (err)` gives `unknown`: narrow with `instanceof` or read `err instanceof Error ? err.message : String(err)`.

## Functions and data

- Prefer plain functions and object literals; a class only for a service with collaborators or an error.
- Small pure helpers over clever generics. Add a type parameter only when two real callers need it.
- `readonly` for constructor-injected collaborators (`private readonly db: Db`).
- Constants that are policy (limits, timeouts, key names) are named `UPPER_SNAKE` at the top of the module that owns them.
