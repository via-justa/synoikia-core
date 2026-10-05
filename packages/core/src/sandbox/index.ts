import ivm from 'isolated-vm';

/** Runs model code in a fresh V8 isolate with no Node APIs (design §5.4); only `bindings` reach out, and
 * values cross as JSON. `code` is an async function body. */

export interface SandboxLimits {
  /** Wall-clock budget for sandbox activity. Time a binding spends paused (human approval) is excluded. */
  timeoutMs: number;
  memoryMb: number;
  /** Maximum size of the JSON-encoded result; larger results are truncated with a marker. */
  maxResultBytes: number;
  maxLogBytes: number;
}

const DEFAULT_LIMITS: SandboxLimits = {
  timeoutMs: 10_000,
  memoryMb: 64,
  maxResultBytes: 64 * 1024,
  maxLogBytes: 16 * 1024,
};

/** Thrown by a binding to surface a structured error (`err.code`) inside the sandbox. */
export class BindingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BindingError';
  }
}

/** Lets a binding stop the sandbox clock while it waits on something slow and human, like approval. */
export interface BudgetControl {
  pause(): void;
  resume(): void;
  /** Milliseconds of sandbox budget left. */
  remainingMs(): number;
}

export type Binding = (args: unknown[], budget: BudgetControl) => Promise<unknown>;

export interface SandboxRun {
  code: string;
  /** `{ acme: { call: fn } }` becomes `acme.call(...)` inside the sandbox. */
  bindings: Record<string, Record<string, Binding>>;
  limits?: Partial<SandboxLimits>;
  /** Applied to everything leaving the sandbox (result, `console.log` arguments, errors). */
  redact?: (value: unknown) => unknown;
}

export type SandboxResult =
  | { ok: true; value: unknown; truncated: boolean; logs: string[] }
  | { ok: false; error: { code: string; message: string }; logs: string[] };

const RESERVED = new Set(['console', 'globalThis', '__syn']);
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Wall-clock budget that can be paused; fires `onExpire` once when it runs out. */
class Budget implements BudgetControl {
  private remaining: number;
  private startedAt = 0;
  private paused = 0;
  private timer?: NodeJS.Timeout;
  expired = false;

  constructor(
    totalMs: number,
    private readonly onExpire: () => void,
  ) {
    this.remaining = totalMs;
  }

  start() {
    this.startedAt = Date.now();
    this.timer = setTimeout(() => {
      this.expired = true;
      this.onExpire();
    }, this.remaining);
  }

  pause() {
    if (this.paused++ > 0 || this.expired) return;
    clearTimeout(this.timer);
    this.remaining -= Date.now() - this.startedAt;
  }

  resume() {
    if (--this.paused > 0 || this.expired) return;
    this.start();
  }

  remainingMs() {
    return this.paused > 0 ? this.remaining : Math.max(0, this.remaining - (Date.now() - this.startedAt));
  }

  stop() {
    clearTimeout(this.timer);
  }
}

// Prelude script run before the user's: it keeps host references in its closure, installs `console`
// and frozen binding namespaces, and deletes `__syn` from the global.
const prelude = (spec: Record<string, string[]>) => `(() => {
  const call = globalThis.__syn.call;
  const log = globalThis.__syn.log;
  delete globalThis.__syn;
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  globalThis.console = Object.freeze({
    log: (...a) => log.applySync(undefined, [stringify(a.map((x) => x === undefined ? null : x))]),
  });
  const bind = (ns, fn) => async (...args) => {
    const raw = await call.apply(undefined, [ns, fn, stringify(args)], { result: { promise: true } });
    const res = parse(raw);
    if (res.ok) return res.value;
    const err = new Error(res.error.message);
    err.code = res.error.code;
    throw err;
  };
  const spec = ${JSON.stringify(spec)};
  for (const ns of Object.keys(spec)) {
    const fns = {};
    for (const fn of spec[ns]) fns[fn] = bind(ns, fn);
    globalThis[ns] = Object.freeze(fns);
  }
})();`;

function toJson(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

export async function runInSandbox(run: SandboxRun): Promise<SandboxResult> {
  const limits = { ...DEFAULT_LIMITS, ...run.limits };
  const redact = run.redact ?? ((v: unknown) => v);
  // Redacted as strings, so secret values are scrubbed but a plugin's sensitive key named `code`
  // (a PIN, say) can't hide the error code itself.
  const redactError = (e: { code: string; message: string }) => ({
    code: String(redact(e.code)),
    message: String(redact(e.message)),
  });
  const logs: string[] = [];
  let logBytes = 0;
  const isolate = new ivm.Isolate({ memoryLimit: limits.memoryMb });
  const budget = new Budget(limits.timeoutMs, () => {
    if (!isolate.isDisposed) isolate.dispose();
  });

  try {
    const context = await isolate.createContext();
    const jail = context.global;
    await jail.set('globalThis', jail.derefInto());

    const hostCall = async (ns: string, fn: string, argsJson: string): Promise<string> => {
      // Own properties only: `constructor`, `__proto__` and friends are not bindings.
      const fns = Object.hasOwn(run.bindings, ns) ? run.bindings[ns] : undefined;
      const binding = fns && Object.hasOwn(fns, fn) ? fns[fn] : undefined;
      if (!binding)
        return toJson({ ok: false, error: { code: 'NOT_A_BINDING', message: `${ns}.${fn} is not available` } });
      try {
        const args = JSON.parse(argsJson) as unknown[];
        return toJson({ ok: true, value: await binding(args, budget) });
      } catch (err) {
        const code = err instanceof BindingError ? err.code : 'INTERNAL';
        const message = err instanceof BindingError ? err.message : 'Internal error in binding';
        return toJson({ ok: false, error: { code, message } });
      }
    };
    const hostLog = (argsJson: string) => {
      if (logBytes >= limits.maxLogBytes) return;
      let args: unknown[];
      try {
        args = JSON.parse(argsJson) as unknown[];
      } catch {
        args = ['[unprintable]'];
      }
      // Redact the values, then format: a JSON string of a secret has no key left to redact by.
      const line = (redact(args) as unknown[]).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
      const text = line.slice(0, limits.maxLogBytes - logBytes);
      logBytes += text.length;
      logs.push(text);
    };
    await jail.set('__syn', new ivm.ExternalCopy({}).copyInto());
    const syn = (await jail.get('__syn')) as ivm.Reference<Record<string, unknown>>;
    await syn.set('call', new ivm.Reference(hostCall));
    await syn.set('log', new ivm.Reference(hostLog));

    const spec = Object.fromEntries(
      Object.entries(run.bindings)
        .filter(([ns]) => IDENT.test(ns) && !RESERVED.has(ns))
        .map(([ns, fns]) => [ns, Object.keys(fns).filter((fn) => IDENT.test(fn))]),
    );
    await (await isolate.compileScript(prelude(spec))).run(context);

    // The user's code is a separate script: it can't see the prelude's closure.
    // Always settle with a JSON envelope so thrown errors keep their \`code\` across the boundary.
    const source = `(async () => {\n${run.code}\n})().then(
  (v) => JSON.stringify({ ok: true, value: v === undefined ? null : v }),
  (e) => JSON.stringify({ ok: false, error: { code: typeof e?.code === 'string' ? e.code : 'CODE_ERROR', message: String(e?.message ?? e) } }),
)`;
    const script = await isolate.compileScript(source).catch((err: Error) => {
      throw new SandboxFailure('SYNTAX_ERROR', err.message);
    });

    budget.start();
    const json = (await script.run(context, { promise: true, timeout: limits.timeoutMs })) as string;
    budget.stop();

    const envelope = JSON.parse(json) as
      { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };
    if (!envelope.ok) return { ok: false, error: redactError(envelope.error), logs };
    // Redact before measuring: the preview of an oversized result is raw text, beyond key redaction.
    const value = redact(envelope.value);
    const valueJson = JSON.stringify(value);
    const bytes = Buffer.byteLength(valueJson);
    if (bytes > limits.maxResultBytes) {
      const preview = Buffer.from(valueJson).subarray(0, limits.maxResultBytes).toString('utf8');
      return { ok: true, value: { truncated: true, bytes, preview }, truncated: true, logs };
    }
    return { ok: true, value, truncated: false, logs };
  } catch (err) {
    budget.stop();
    return {
      ok: false,
      error: redactError(classify(err, budget.expired, isolate)),
      logs,
    };
  } finally {
    if (!isolate.isDisposed) isolate.dispose();
  }
}

class SandboxFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function classify(err: unknown, expired: boolean, isolate: ivm.Isolate): { code: string; message: string } {
  if (err instanceof SandboxFailure) return { code: err.code, message: err.message };
  const message = err instanceof Error ? err.message : String(err);
  if (expired || /timed out/i.test(message)) return { code: 'TIMEOUT', message: 'Sandbox time limit exceeded' };
  if (/memory limit/i.test(message) || isolate.isDisposed) {
    return { code: 'MEMORY_LIMIT', message: 'Sandbox memory limit exceeded' };
  }
  // A synchronous throw at top level (the envelope catches everything asynchronous).
  return { code: 'CODE_ERROR', message };
}
