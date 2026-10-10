import { QueryClient } from '@tanstack/vue-query';

/** Reads the double-submit CSRF cookie set by the admin listener (design §6.1). */
function csrfToken(): string | undefined {
  return document.cookie
    .split('; ')
    .find((c) => c.startsWith('syn_csrf='))
    ?.slice('syn_csrf='.length);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function api<T>(path: string, init: { method?: Method; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const csrf = csrfToken();
  if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf;

  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string; details?: unknown };
  if (!res.ok) {
    if (res.status === 401 && data.error === 'unauthenticated') onUnauthenticated?.();
    throw new ApiError(res.status, data.message ?? data.error ?? res.statusText, data.error, data.details);
  }
  return data as T;
}

/** Set by the router: a 401 from any call sends the user back to the login page. */
let onUnauthenticated: (() => void) | undefined;
export function setUnauthenticatedHandler(fn: () => void) {
  onUnauthenticated = fn;
}

export const http = {
  get: <T>(path: string) => api<T>(path),
  post: <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body }),
  del: <T = void>(path: string, body?: unknown) => api<T>(path, { method: 'DELETE', body }),
};

/** Human message for a failed call, with validation details when present. */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const details = Array.isArray(err.details) ? err.details.filter((d) => typeof d === 'string') : [];
    return details.length ? `${err.message}: ${details.join('; ')}` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export const qs = (params: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** A query key mirroring an API path: `/api/instances/i1/rules` → `['instances', 'i1', 'rules']`. */
export const pathKey = (path: string) => path.replace(/^\/api\//, '').split('/');

/** The portal's query defaults; the app and each test mount create their own client. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // A 4xx (403, 404, validation) won't change on retry.
        retry: (failures, err) => failures < 1 && !(err instanceof ApiError && err.status >= 400 && err.status < 500),
      },
    },
  });
}
