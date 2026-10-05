import semver from 'semver';
import { ZodError } from 'zod';
import { parseManifest } from './manifest.js';
import type { Manifest } from './manifest.js';
import {
  GuideSchema,
  RegistryEntrySchema,
  ResolvedTargetSchema,
  ResolveOperationResultSchema,
  SummarizeResultSchema,
  SyncCatalogResultSchema,
  TestConnectionResultSchema,
} from './operations.js';
import type { PluginSettings } from './rules.js';
import type { InitParams, PluginHandlers } from './rpc.js';
import { SDK_VERSION, SENSITIVE_RESULT_SINCE } from './version.js';

/** In-process conformance checks against the plugin's fake upstream, as core validates plugin output:
 * `expect(await checkConformance(…)).toEqual([])`. */

export interface ConformanceSample {
  /** Binding function and arguments, as sandboxed code would call them: `acme.call('widget.list', [])`. */
  fn: string;
  args: unknown[];
  /** Catalog key `resolveOperation` must produce. */
  expectKey: string;
}

export interface ConformanceOptions {
  manifest: unknown;
  handlers: PluginHandlers;
  /** Passed to `init`; point it at the plugin's fake upstream. */
  init: Omit<InitParams, 'sdkVersion'>;
  samples?: ConformanceSample[];
  /** `resolveOperation` calls that must be rejected (unknown or malformed operations). */
  rejects?: Omit<ConformanceSample, 'expectKey'>[];
  /** The plugin's parsed `plugin.yaml`, checked against the manifest. */
  settings?: PluginSettings<unknown>;
}

/** Whether every core the manifest's `sdk` range accepts masks `sensitiveResult` itself. */
export function sdkMasksResults(manifest: Pick<Manifest, 'sdk'>): boolean {
  const min = semver.minVersion(manifest.sdk);
  return min !== null && semver.gte(min, SENSITIVE_RESULT_SINCE);
}

const sensitiveResultNeedsSdk = (where: string, sdk: string) =>
  `${where}: sensitiveResult is masked by core from contract ${SENSITIVE_RESULT_SINCE}, but manifest sdk ${sdk} accepts older cores that would drop it; require ^${SENSITIVE_RESULT_SINCE}`;

/** Manifest checks beyond the schema: secret fields, network hosts, match profiles named by rules, and
 * the contract `sensitiveResult` rules need. Returns the problems found. */
export function checkManifest(input: unknown, settings?: PluginSettings<unknown>): string[] {
  let manifest: Manifest;
  try {
    manifest = parseManifest(input);
  } catch (err) {
    return [`manifest: ${explain(err)}`];
  }
  const issues: string[] = [];
  const props = (manifest.connection.schema.properties ?? {}) as Record<string, { writeOnly?: boolean }>;
  for (const [name, prop] of Object.entries(props)) {
    const secret = manifest.connection.ui[name]?.widget === 'secret';
    if (secret && prop?.writeOnly !== true) issues.push(`connection.${name}: a secret field must be writeOnly`);
    if (prop?.writeOnly === true && !secret)
      issues.push(`connection.${name}: a writeOnly field must use the secret widget`);
    if ((secret || prop?.writeOnly === true) && !manifest.sensitiveKeys.includes(name))
      issues.push(`connection.${name}: a secret field must be listed in sensitiveKeys`);
  }
  if (manifest.network.hosts.length === 0)
    issues.push(
      'network.hosts: names no host; list the hosts the plugin connects to, which admins review before enabling it',
    );
  for (const [i, rule] of (settings?.rules ?? []).entries()) {
    if (rule.matchProfile && !manifest.matchProfiles[rule.matchProfile])
      issues.push(`plugin.yaml rules[${i}]: matchProfile "${rule.matchProfile}" is not in the manifest`);
    if (rule.sensitiveResult && !sdkMasksResults(manifest))
      issues.push(sensitiveResultNeedsSdk(`plugin.yaml rules[${i}]`, manifest.sdk));
  }
  return issues;
}

const OPTIONAL_BY_CAPABILITY = {
  registry: 'syncRegistry',
  targets: 'resolveTargets',
  configTransform: 'prepareWrite',
  attestation: 'getGuide',
} as const;

function explain(err: unknown): string {
  if (err instanceof ZodError) return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  return err instanceof Error ? err.message : String(err);
}

export async function checkConformance(opts: ConformanceOptions): Promise<string[]> {
  const issues: string[] = opts.settings ? checkManifest(opts.manifest, opts.settings) : [];
  const { handlers } = opts;

  let manifest: Manifest;
  try {
    manifest = parseManifest(opts.manifest);
  } catch (err) {
    return [`manifest: ${explain(err)}`];
  }

  for (const [capability, method] of Object.entries(OPTIONAL_BY_CAPABILITY)) {
    const declared = manifest.capabilities[capability as keyof typeof OPTIONAL_BY_CAPABILITY];
    const implemented = typeof handlers[method] === 'function';
    if (declared && !implemented) issues.push(`capabilities.${capability} is declared but ${method} is missing`);
    if (!declared && implemented)
      issues.push(`${method} is implemented but capabilities.${capability} is not declared`);
  }

  try {
    await handlers.init({ ...opts.init, sdkVersion: SDK_VERSION });
  } catch (err) {
    return [...issues, `init: ${explain(err)}`];
  }

  const call = async <T>(label: string, fn: () => unknown, parse: (v: unknown) => T): Promise<T | undefined> => {
    try {
      return parse(await fn());
    } catch (err) {
      issues.push(`${label}: ${explain(err)}`);
      return undefined;
    }
  };

  await call(
    'testConnection',
    () => handlers.testConnection(),
    (v) => TestConnectionResultSchema.parse(v),
  );
  await call(
    'getUpstreamVersion',
    () => handlers.getUpstreamVersion(),
    (v) => {
      if (typeof v !== 'string' || v === '') throw new Error('must return a non-empty string');
      return v;
    },
  );

  const result = await call(
    'syncCatalog',
    () => handlers.syncCatalog(),
    (v) => SyncCatalogResultSchema.parse(v),
  );
  const keys = new Set<string>();
  for (const op of result?.operations ?? []) {
    if (keys.has(op.key)) issues.push(`syncCatalog: duplicate key ${op.key}`);
    keys.add(op.key);
    if (op.locked && op.classification !== 'write')
      issues.push(`syncCatalog: locked ${op.key} must be classified write`);
    if (op.matchProfile && !manifest.matchProfiles[op.matchProfile]) {
      issues.push(`syncCatalog: ${op.key} references unknown matchProfile "${op.matchProfile}"`);
    }
    if (op.sensitiveResult && !sdkMasksResults(manifest))
      issues.push(sensitiveResultNeedsSdk(`syncCatalog: ${op.key}`, manifest.sdk));
    if (op.attestationRequired && !manifest.capabilities.attestation) {
      issues.push(`syncCatalog: ${op.key} requires attestation but capabilities.attestation is not declared`);
    }
  }
  if (result && result.operations.length === 0) issues.push('syncCatalog: returned no operations');

  if (manifest.capabilities.registry && handlers.syncRegistry) {
    await call(
      'syncRegistry',
      () => handlers.syncRegistry!(),
      (v) => RegistryEntrySchema.array().parse(v),
    );
  }

  for (const sample of opts.samples ?? []) {
    const label = `resolveOperation(${sample.fn} ${JSON.stringify(sample.args)})`;
    if (!manifest.binding.functions.includes(sample.fn)) {
      issues.push(`${label}: ${sample.fn} is not a binding function in the manifest`);
      continue;
    }
    const resolved = await call(
      label,
      () => handlers.resolveOperation({ fn: sample.fn, args: sample.args }),
      (v) => ResolveOperationResultSchema.parse(v),
    );
    if (!resolved) continue;
    if (resolved.key !== sample.expectKey)
      issues.push(`${label}: resolved to ${resolved.key}, expected ${sample.expectKey}`);
    if (result && !keys.has(resolved.key)) issues.push(`${label}: resolved key ${resolved.key} is not in the catalog`);

    const targets = handlers.resolveTargets
      ? await call(
          `resolveTargets(${resolved.key})`,
          () => handlers.resolveTargets!({ key: resolved.key, params: resolved.params }),
          (v) => ResolvedTargetSchema.array().parse(v),
        )
      : [];
    const summary = await call(
      `summarize(${resolved.key})`,
      () => handlers.summarize({ key: resolved.key, params: resolved.params, targets: targets ?? [] }),
      (v) => SummarizeResultSchema.parse(v),
    );
    const descriptor = result?.operations.find((o) => o.key === resolved.key);
    if (summary && descriptor && (descriptor.typedConfirmation ?? descriptor.locked) && !summary.confirmLiteral) {
      issues.push(`summarize(${resolved.key}): typed-confirmation operations must return a confirmLiteral`);
    }
    if (descriptor?.attestationRequired && handlers.getGuide) {
      await call(
        `getGuide(${resolved.key})`,
        () => handlers.getGuide!({ key: resolved.key }),
        (v) => GuideSchema.parse(v),
      );
    }
  }

  for (const reject of opts.rejects ?? []) {
    try {
      await handlers.resolveOperation({ fn: reject.fn, args: reject.args });
      issues.push(`resolveOperation(${reject.fn} ${JSON.stringify(reject.args)}): expected rejection, got a result`);
    } catch {
      // expected
    }
  }

  return issues;
}
