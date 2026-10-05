import { ErrorCodes, PluginError } from './errors.js';

/** Request/response bookkeeping for message-based protocols: ids, a timer per request, and failing all
 * pending calls when the connection drops. */

interface Entry {
  label: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface PendingRequest {
  id: number;
  promise: Promise<unknown>;
}

export interface Settler {
  /** The label given to `start`, e.g. the method name, for error messages. */
  label: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export class PendingRequests {
  private nextId = 1;
  private readonly entries = new Map<number, Entry>();

  constructor(
    /** Error for a request that got no reply in time. */
    private readonly timeoutError: (label: string, timeoutMs: number) => Error = (label) =>
      new PluginError(ErrorCodes.UpstreamError, `${label}: timed out`),
  ) {}

  /** Registers a request; its promise settles through `take`, a timeout or `failAll`. */
  start(label: string, timeoutMs: number): PendingRequest {
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.entries.delete(id);
        reject(this.timeoutError(label, timeoutMs));
      }, timeoutMs);
      this.entries.set(id, { label, resolve, reject, timer });
    });
    return { id, promise };
  }

  /** Removes a pending request and stops its timer; undefined for an unknown or settled id. */
  take(id: unknown): Settler | undefined {
    if (typeof id !== 'number') return undefined;
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    this.entries.delete(id);
    return entry;
  }

  /** Rejects one request (e.g. its frame could not be sent). Returns whether it was pending. */
  fail(id: number, err: Error): boolean {
    const entry = this.take(id);
    entry?.reject(err);
    return entry !== undefined;
  }

  /** Rejects every pending request, e.g. when the connection closes. */
  failAll(err: Error): void {
    for (const id of [...this.entries.keys()]) this.fail(id, err);
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Shares one in-flight call between concurrent callers (for connecting and signing in). */
export function singleFlight<A extends unknown[], T>(fn: (...args: A) => Promise<T>): (...args: A) => Promise<T> {
  let inFlight: Promise<T> | undefined;
  return (...args: A) => {
    inFlight ??= fn(...args).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
