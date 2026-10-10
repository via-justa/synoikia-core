import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeApi, mountAt, signedIn } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const overview = { instances: [], plugins: [], warnings: [], publicMcpUrl: null };
const gets = (calls: { method: string; path: string }[], path: string) =>
  calls.filter((c) => c.method === 'GET' && c.path === path).length;

describe('cached server data', () => {
  it('is dropped when another user signs in', async () => {
    let session: unknown = signedIn;
    const { calls } = fakeApi({
      'GET /api/session': () => session,
      'GET /api/overview': overview,
      'GET /api/users': [],
      'GET /api/roles': [],
      'POST /auth/logout': {},
      'POST /auth/login': () => {
        session = { ...signedIn, user: { ...signedIn.user, id: 'u3', username: 'root' } };
        return { status: 'ok' };
      },
    });
    const { wrapper, router } = await mountAt('/settings/users');
    expect(gets(calls, '/api/users')).toBe(1);

    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Log out')!
      .trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/login');
    await wrapper.get('input#username').setValue('root');
    await wrapper.get('input#password').setValue('correct horse battery');
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    await router.push('/settings/users');
    await flushPromises();
    expect(gets(calls, '/api/users')).toBe(2);
  });
});

describe('live events', () => {
  it('refresh the overview through its query', async () => {
    const sources: FakeEventSource[] = [];
    class FakeEventSource {
      listeners = new Map<string, (e: MessageEvent<string>) => void>();
      constructor(readonly url: string) {
        sources.push(this);
      }
      addEventListener(name: string, fn: (e: MessageEvent<string>) => void) {
        this.listeners.set(name, fn);
      }
      close() {}
    }
    vi.stubGlobal('EventSource', FakeEventSource);
    const { calls } = fakeApi({ 'GET /api/session': signedIn, 'GET /api/overview': overview });
    await mountAt('/');
    expect(sources.map((s) => s.url)).toEqual(['/api/events']);
    expect(gets(calls, '/api/overview')).toBe(1);

    sources[0]!.listeners.get('instance.status')!(new MessageEvent('instance.status', { data: '{}' }));
    await flushPromises();
    expect(gets(calls, '/api/overview')).toBe(2);
  });
});
