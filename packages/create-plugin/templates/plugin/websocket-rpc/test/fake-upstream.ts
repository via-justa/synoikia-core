import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { authorized } from './fake-auth.js';

/** A fake {{name}} over JSON-RPC/WebSocket, including a secret that must never reach the sandbox. */

export const UPSTREAM_SECRET = 'fake-upstream-secret-123';

export interface Fake{{Pascal}} {
  url: string;
  items: Map<number, { id: number; name: string }>;
  close(): Promise<void>;
}

export async function startFake{{Pascal}}(): Promise<Fake{{Pascal}}> {
  const items = new Map([[1, { id: 1, name: 'First item' }]]);
  let next = 2;
  const methods: Record<string, (p: Record<string, unknown>) => unknown> = {
    'system.info': () => ({ name: 'Home {{name}}', version: '1.2.3' }),
    'items.list': () => [...items.values()],
    'items.get': (p) => items.get(Number(p.id)) ?? null,
    'items.create': (p) => {
      const item = { id: next++, name: String(p.name ?? 'Unnamed') };
      items.set(item.id, item);
      return item;
    },
    'items.delete': (p) => items.delete(Number(p.id)),
    'settings.get': () => ({ title: 'Home', apiKey: UPSTREAM_SECRET }),
  };
  const wss = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    path: '/rpc',
    verifyClient: ({ req }: { req: { headers: Record<string, string | string[] | undefined> } }) =>
      authorized(req.headers),
  });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as { id: number; method: string; params?: Record<string, unknown> };
      const fn = methods[msg.method];
      ws.send(
        JSON.stringify(
          fn
            ? { jsonrpc: '2.0', id: msg.id, result: fn(msg.params ?? {}) }
            : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  return {
    url: `http://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    items,
    close: () =>
      new Promise((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  };
}
