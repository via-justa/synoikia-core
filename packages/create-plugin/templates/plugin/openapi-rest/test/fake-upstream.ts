import { startFakeHttp } from '@synoikia/core/testing';
import type { FakeHttp } from '@synoikia/core/testing';
import { authorized } from './fake-auth.js';

/** A fake {{name}}: enough API to exercise the plugin, including a secret that must never reach the sandbox. */

export const UPSTREAM_SECRET = 'fake-upstream-secret-123';

const SPEC = {
  openapi: '3.0.3',
  paths: {
    '/status': { get: { summary: 'Version and name', tags: ['System'] } },
    '/settings': { get: { summary: 'Settings, including an integration key', tags: ['Settings'] } },
    '/items': {
      get: { summary: 'List items', tags: ['Items'] },
      post: {
        summary: 'Create an item',
        tags: ['Items'],
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } },
        },
      },
    },
    '/items/{itemId}': {
      parameters: [{ name: 'itemId', in: 'path', required: true, schema: { type: 'number' } }],
      get: { summary: 'Get an item', tags: ['Items'] },
      delete: { summary: 'Delete an item', tags: ['Items'] },
    },
  },
};

export interface Fake{{Pascal}} extends FakeHttp {
  items: Map<number, { id: number; name: string }>;
}

export async function startFake{{Pascal}}(): Promise<Fake{{Pascal}}> {
  const items = new Map([[1, { id: 1, name: 'First item' }]]);
  let next = 2;
  const fake = await startFakeHttp({
    guard: (req) => (authorized(req.headers) ? undefined : { status: 401, body: { message: 'Unauthorized' } }),
    routes: {
      'GET /api/status': () => ({ body: { version: '1.2.3', name: 'Home {{name}}' } }),
      'GET /api/openapi.json': () => ({ body: SPEC }),
      'GET /api/settings': () => ({ body: { title: 'Home', apiKey: UPSTREAM_SECRET } }),
      'GET /api/items': () => ({ body: [...items.values()] }),
      'POST /api/items': (req) => {
        const item = { id: next++, name: String((req.body as { name?: unknown })?.name ?? 'Unnamed') };
        items.set(item.id, item);
        return { status: 201, body: item };
      },
      'GET /api/items/{itemId}': (req) => {
        const item = items.get(Number(req.params.itemId));
        return item ? { body: item } : { status: 404, body: { message: 'No such item' } };
      },
      'DELETE /api/items/{itemId}': (req) =>
        items.delete(Number(req.params.itemId)) ? { status: 204 } : { status: 404, body: { message: 'No such item' } },
    },
  });
  return { ...fake, items };
}
