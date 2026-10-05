import type { Manifest } from '@synoikia/plugin-sdk';
import { Ajv } from 'ajv';
import type { ErrorObject, ValidateFunction } from 'ajv';
import * as ajvFormats from 'ajv-formats';
import { ValidationError } from '../errors.js';

// ajv-formats ships CJS (`exports.default = formatsPlugin`); normalize that for NodeNext ESM.
type FormatsPlugin = (ajv: Ajv) => Ajv;
const addFormats = ((ajvFormats as unknown as { default: { default?: FormatsPlugin } & FormatsPlugin }).default
  .default ?? (ajvFormats as unknown as { default: FormatsPlugin }).default) as FormatsPlugin;

const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
addFormats(ajv);

/** Compiled validators cached by schema content (ajv keeps them, and recompiling an `$id` throws). */
const compiled = new Map<string, ValidateFunction>();
const MAX_COMPILED = 200;

function validatorFor(schema: Manifest['connection']['schema']): ValidateFunction {
  const key = JSON.stringify(schema);
  let validate = compiled.get(key);
  if (!validate) {
    validate = ajv.compile(schema);
    // Unregister the `$id` so another version of the same plugin can compile its own schema under it.
    const id = (schema as { $id?: unknown }).$id;
    if (typeof id === 'string') ajv.removeSchema(id);
    if (compiled.size >= MAX_COMPILED) compiled.delete(compiled.keys().next().value!);
    compiled.set(key, validate);
  }
  return validate;
}

/** Connection config (design §7.2, §8.3): `writeOnly` fields are secrets, encrypted, sent only via
 * `init` and returned by the API only as `{ set, hint }`. */

export function secretFieldNames(manifest: Manifest): string[] {
  const props = (manifest.connection.schema.properties ?? {}) as Record<string, { writeOnly?: boolean }>;
  return Object.entries(props)
    .filter(([, p]) => p?.writeOnly === true)
    .map(([k]) => k);
}

const describeErrors = (errors: ErrorObject[] | null | undefined) =>
  (errors ?? []).map((e) => `${e.instancePath || '(connection)'} ${e.message ?? 'is invalid'}`.trim());

/** Validates the merged config + secrets against the plugin's schema and splits them again. */
export function validateConnection(
  manifest: Manifest,
  input: Record<string, unknown>,
): { config: Record<string, unknown>; secrets: Record<string, string> } {
  const validate = validatorFor(manifest.connection.schema);
  const candidate = structuredClone(input);
  if (!validate(candidate)) {
    throw new ValidationError('invalid_connection', 'Connection settings are invalid', describeErrors(validate.errors));
  }
  const secretNames = new Set(secretFieldNames(manifest));
  const config: Record<string, unknown> = {};
  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(candidate)) {
    if (secretNames.has(k)) {
      if (v !== undefined && v !== null && v !== '') secrets[k] = String(v);
    } else {
      config[k] = v;
    }
  }
  return { config, secrets };
}

/** Applies a secrets patch: a value replaces, `null` clears, omitted keeps; unknown keys are rejected. */
export function mergeSecrets(
  manifest: Manifest,
  current: Record<string, string>,
  patch: Record<string, string | null | undefined>,
): Record<string, string> {
  const names = new Set(secretFieldNames(manifest));
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (!names.has(k)) throw new ValidationError('unknown_secret', `"${k}" is not a secret field of this plugin`);
    if (v === null) delete next[k];
    else if (v !== undefined && v !== '') next[k] = v;
  }
  return next;
}

export interface SecretSummary {
  set: boolean;
  /** Last 4 characters, only for values long enough that this reveals little. */
  hint?: string;
}

export function summarizeSecrets(manifest: Manifest, secrets: Record<string, string>): Record<string, SecretSummary> {
  return Object.fromEntries(
    secretFieldNames(manifest).map((name) => {
      const v = secrets[name];
      return [name, v ? { set: true, ...(v.length >= 12 ? { hint: `…${v.slice(-4)}` } : {}) } : { set: false }];
    }),
  );
}

const ADDRESS_FORMATS = new Set(['uri', 'url', 'hostname', 'ipv4', 'ipv6', 'idn-hostname', 'iri']);
const ADDRESS_NAME = /(url|uri|host|server|endpoint|address|domain|origin)/i;

/** Non-secret fields that say where the upstream is: changing one decides where the secrets are sent. */
function addressFieldNames(manifest: Manifest): string[] {
  const props = (manifest.connection.schema.properties ?? {}) as Record<
    string,
    { writeOnly?: boolean; format?: string }
  >;
  return Object.entries(props)
    .filter(([k, p]) => p?.writeOnly !== true && (ADDRESS_FORMATS.has(p?.format ?? '') || ADDRESS_NAME.test(k)))
    .map(([k]) => k);
}

/** The stored secrets a candidate connection may use: none if it moves the upstream, so a changed URL
 * never receives the stored key (design §7.2). */
export function storedSecretsFor(
  manifest: Manifest,
  current: { config: Record<string, unknown>; secrets: Record<string, string> },
  candidate: { config: Record<string, unknown>; secrets?: Record<string, string | null> },
): Record<string, string> {
  const moved = addressFieldNames(manifest).filter(
    (k) => JSON.stringify(candidate.config[k] ?? null) !== JSON.stringify(current.config[k] ?? null),
  );
  if (moved.length === 0) return current.secrets;
  const missing = Object.keys(current.secrets).filter((k) => !candidate.secrets?.[k]);
  if (missing.length > 0) {
    throw new ValidationError(
      'secrets_required',
      `Changing ${moved.join(', ')} changes where credentials are sent: enter ${missing.join(', ')} again`,
      missing,
    );
  }
  return {};
}
