import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import App from '../src/App.vue';
import { createAppRouter } from '../src/router';

export function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type Handler = (body: unknown, url: URL) => Response | unknown;

/** A fake Admin API: `routes['GET /api/x']` returns a Response or a JSON body; calls are recorded. */
export function fakeApi(routes: Record<string, Handler | unknown>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://admin.test');
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname + url.search, body });
    const route = routes[`${method} ${url.pathname}${url.search}`] ?? routes[`${method} ${url.pathname}`];
    if (route === undefined) return json(404, { error: 'not_found', message: `${method} ${url.pathname}` });
    const out = typeof route === 'function' ? (route as Handler)(body, url) : route;
    return out instanceof Response ? out : json(200, out);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

export const adminRole = {
  id: 'admin',
  name: 'Admin',
  isAdmin: true,
  canSetOwnLevels: true,
  canManageOwnRules: true,
  canSeeStatus: true,
};

export const signedIn = {
  authenticated: true,
  setupRequired: false,
  localLoginEnabled: true,
  oidc: { enabled: false, label: 'SSO' },
  user: {
    id: 'u1',
    username: 'admin',
    totpEnabled: false,
    oidcLinked: false,
    hasPassword: true,
    disabled: false,
    role: adminRole,
  },
  mustEnrollTotp: false,
};

export async function mountAt(path: string) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createAppRouter(createMemoryHistory());
  await router.push(path);
  await router.isReady();
  const wrapper = mount(App, { global: { plugins: [pinia, router] }, attachTo: document.body });
  await flushPromises();
  return { wrapper, router };
}
