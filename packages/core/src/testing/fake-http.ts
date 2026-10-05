import http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A fake HTTP upstream for plugin tests: `METHOD /path` routes with `{param}`, JSON, request log. */

export interface FakeRequest {
  method: string;
  /** Path without the query string. */
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  /** Parsed JSON body, the raw text if it isn't JSON, or undefined when empty. */
  body: unknown;
  /** `{param}` values from the matched route. */
  params: Record<string, string>;
}

export interface FakeResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string | string[]>;
}

/** A route answers with a body (status 200) or a full `FakeResponse` from `reply`. */
export type FakeRoute = (req: FakeRequest) => FakeResponse | Promise<FakeResponse>;

export interface FakeHttpOptions {
  /** `'GET /items/{id}': (req) => ({ body: … })`. Unmatched requests get 404. */
  routes: Record<string, FakeRoute>;
  /** Runs before routing; return a response to short-circuit (e.g. 401 without credentials). */
  guard?: (req: FakeRequest) => FakeResponse | undefined;
}

export interface FakeHttp {
  /** `http://127.0.0.1:<port>` */
  url: string;
  requests: FakeRequest[];
  close(): Promise<void>;
}

function compile(pattern: string): { method: string; re: RegExp; names: string[] } {
  const [method, path] = pattern.split(' ') as [string, string];
  const names: string[] = [];
  const re = new RegExp(
    `^${path
      .split('/')
      .map((seg) => {
        const m = /^\{(.+)\}$/.exec(seg);
        if (!m) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        names.push(m[1]!);
        return '([^/]+)';
      })
      .join('/')}$`,
  );
  return { method: method.toUpperCase(), re, names };
}

export async function startFakeHttp(opts: FakeHttpOptions): Promise<FakeHttp> {
  const routes = Object.entries(opts.routes).map(([pattern, route]) => ({ ...compile(pattern), route }));
  const requests: FakeRequest[] = [];
  const server = http.createServer((req, res) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (text += c));
    req.on('end', () => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://fake');
        let body: unknown;
        if (text) {
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
        }
        const request: FakeRequest = {
          method: req.method ?? 'GET',
          path: url.pathname,
          query: url.searchParams,
          headers: req.headers,
          body,
          params: {},
        };
        requests.push(request);
        let reply: FakeResponse | undefined = opts.guard?.(request);
        if (!reply) {
          const hit = routes.find((r) => r.method === request.method && r.re.test(url.pathname));
          if (hit) {
            const m = hit.re.exec(url.pathname)!;
            hit.names.forEach((name, i) => {
              request.params[name] = decodeURIComponent(m[i + 1]!);
            });
            try {
              reply = await hit.route(request);
            } catch (err) {
              reply = { status: 500, body: { message: err instanceof Error ? err.message : String(err) } };
            }
          } else {
            reply = { status: 404, body: { message: 'Not found' } };
          }
        }
        const payload =
          reply.body === undefined ? '' : typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
        res.writeHead(reply.status ?? 200, {
          ...(payload && typeof reply.body !== 'string' ? { 'content-type': 'application/json' } : {}),
          ...reply.headers,
        });
        res.end(payload);
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
