import { describe, expect, it } from 'vitest';
import { createDispatcher, ErrorCodes, PluginError } from '../src/index.js';
import type { OperationDescriptor, PluginHandlers } from '../src/index.js';

const handlers: PluginHandlers = {
  init: () => undefined,
  testConnection: () => ({ ok: true }),
  getUpstreamVersion: () => '25.10.1',
  syncCatalog: () => ({ upstreamVersion: '25.10.1', operations: [] }),
  resolveOperation: ({ args }) => {
    if (args[0] === 'nope') throw new PluginError(ErrorCodes.UnknownOperation, 'unknown operation: nope');
    return { key: String(args[0]), params: args[1] };
  },
  summarize: () => ({ text: 'summary' }),
  invoke: () => {
    throw new Error('boom');
  },
};

const dispatch = createDispatcher(handlers);
const req = (method: string, params?: unknown) => ({ jsonrpc: '2.0' as const, id: 7, method, params });

describe('createDispatcher', () => {
  it('returns handler results', async () => {
    await expect(dispatch(req('getUpstreamVersion'))).resolves.toEqual({ jsonrpc: '2.0', id: 7, result: '25.10.1' });
    await expect(dispatch(req('resolveOperation', { fn: 'call', args: ['store.query', {}] }))).resolves.toMatchObject({
      result: { key: 'store.query', params: {} },
    });
  });

  it('maps void results to null', async () => {
    await expect(dispatch(req('init', {}))).resolves.toEqual({ jsonrpc: '2.0', id: 7, result: null });
  });

  it('rejects unknown and unimplemented optional methods', async () => {
    for (const method of ['doesNotExist', 'syncRegistry', 'constructor', 'toString']) {
      const res = await dispatch(req(method));
      expect(res).toMatchObject({ error: { code: ErrorCodes.MethodNotFound } });
    }
  });

  it('preserves PluginError codes', async () => {
    const res = await dispatch(req('resolveOperation', { fn: 'call', args: ['nope'] }));
    expect(res).toMatchObject({ error: { code: ErrorCodes.UnknownOperation, message: 'unknown operation: nope' } });
  });

  it('maps unexpected errors to INTERNAL', async () => {
    const res = await dispatch(req('invoke', { key: 'x', params: {} }));
    expect(res).toMatchObject({ error: { code: ErrorCodes.Internal, message: 'boom' } });
  });
});

describe('createDispatcher on a core that does not mask sensitiveResult', () => {
  const catalog: { upstreamVersion: string; operations: OperationDescriptor[] } = {
    upstreamVersion: '1',
    operations: [
      {
        key: 'token.make',
        kind: 'method',
        group: 'g',
        classification: 'write',
        classificationReason: 'x',
        sensitiveResult: 'whole',
      },
      { key: 'item.query', kind: 'method', group: 'g', classification: 'read', classificationReason: 'x' },
    ],
  };
  const make = () => {
    let syncs = 0;
    const invoked: string[] = [];
    const d = createDispatcher({
      ...handlers,
      syncCatalog: () => {
        syncs++;
        return catalog;
      },
      invoke: ({ key }) => {
        invoked.push(key);
        return { token: 'raw-secret' };
      },
    });
    return { d, invoked, syncs: () => syncs };
  };
  const invoke = (key: string) => req('invoke', { key, params: {}, context: { callId: 'c', deadlineMs: 1000 } });

  it('refuses the catalog sync and calls to operations with result secrets, and runs the rest', async () => {
    const t = make();
    await t.d(req('init', { instanceId: 'i', config: {}, secrets: {}, sdkVersion: '0.2.1' }));
    const sync = await t.d(req('syncCatalog'));
    expect(sync).toMatchObject({
      error: { code: ErrorCodes.Internal, message: expect.stringMatching(/token\.make.*0\.2\.2/) },
    });
    // A catalog synced before the update may still be served: the call itself is refused.
    expect(await t.d(invoke('token.make'))).toMatchObject({ error: { code: ErrorCodes.Internal } });
    expect(await t.d(invoke('item.query'))).toMatchObject({ result: { token: 'raw-secret' } });
    expect(t.invoked).toEqual(['item.query']);
  });

  it('learns which operations declare result secrets on its own when core never synced', async () => {
    const t = make();
    await t.d(req('init', { instanceId: 'i', config: {}, secrets: {}, sdkVersion: 'not-a-version' }));
    expect(await t.d(invoke('token.make'))).toMatchObject({ error: { code: ErrorCodes.Internal } });
    expect(await t.d(invoke('item.query'))).toMatchObject({ result: { token: 'raw-secret' } });
    expect(t.syncs()).toBe(1);
  });

  it('stays out of the way on a core that masks them', async () => {
    const t = make();
    await t.d(req('init', { instanceId: 'i', config: {}, secrets: {}, sdkVersion: '0.2.2' }));
    expect(await t.d(req('syncCatalog'))).toMatchObject({ result: catalog });
    expect(await t.d(invoke('token.make'))).toMatchObject({ result: { token: 'raw-secret' } });
    expect(t.syncs()).toBe(1);
  });
});
