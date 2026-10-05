import { randomUUID } from 'node:crypto';
import { cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OperationDescriptor } from '@synoikia/plugin-sdk';
import { eq } from 'drizzle-orm';
import { createAppContext } from '../src/app.js';
import type { AppOptions } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { openDatabase } from '../src/db/index.js';
import type { Db } from '../src/db/index.js';
import { pluginInstances, plugins } from '../src/db/schema.js';

export function seedInstance(db: Db = openDatabase(':memory:'), slug = 'acme') {
  const pluginRowId = randomUUID();
  db.insert(plugins)
    .values({
      id: pluginRowId,
      pluginId: `p-${slug}`,
      version: '0.1.0',
      path: '/tmp',
      manifest: {},
      status: 'ok',
      enabled: true,
    })
    .run();
  const instanceId = randomUUID();
  db.insert(pluginInstances).values({ id: instanceId, pluginId: pluginRowId, slug, displayName: slug }).run();
  return { db, instanceId };
}

export const op = (key: string, extra: Partial<OperationDescriptor> = {}): OperationDescriptor => {
  const isRead = /\.(query|get_instance|config)$/.test(key);
  return {
    key,
    kind: 'method',
    group: key.split('.').slice(0, -1).join('.') || key,
    classification: isRead ? 'read' : 'write',
    classificationReason: isRead ? 'naming:read' : 'naming:write',
    ...extra,
  };
};

export const catalog = (...operations: OperationDescriptor[]) => ({ upstreamVersion: '25.10.7', operations });

const FIXTURE_PLUGINS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/plugins');

/** An app with the fixture plugins installed and enabled; `env.DATA_DIR` is required. */
export async function createTestApp(env: Record<string, string | undefined>, opts?: AppOptions) {
  cpSync(FIXTURE_PLUGINS, path.join(env.DATA_DIR!, 'plugins'), { recursive: true });
  const ctx = await createAppContext(loadConfig(env), opts);
  ctx.db.update(plugins).set({ enabled: true }).where(eq(plugins.status, 'ok')).run();
  return ctx;
}
