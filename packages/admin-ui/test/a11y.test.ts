import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import ChipsInput from '../src/components/ChipsInput.vue';
import { announcement } from '../src/composables/useAnnounce';
import { fakeApi, mountAt, signedIn } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const instance = {
  id: 'i1',
  slug: 'nas',
  displayName: 'Acme',
  enabled: true,
  authMode: null,
  status: 'ready',
  statusError: null,
  upstreamVersion: null,
  lastSyncedAt: null,
  lastSyncStatus: 'ok',
  endpointUrl: 'https://mcp.example.com/nas',
  settings: {},
  plugin: { id: 'p1', pluginId: 'acme', name: 'Acme', enabled: true, status: 'ok', labels: {} },
};
const overview = { instances: [instance], plugins: [], warnings: [], publicMcpUrl: null };

const liveRegion = () => document.body.querySelector('[aria-live="polite"]')!;
const link = (text: string) =>
  [...document.body.querySelectorAll<HTMLAnchorElement>('nav a')].find((a) => a.textContent?.trim() === text)!;
const press = (target: Element, key: string) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
};

async function mountShell(path: string) {
  fakeApi({ 'GET /api/session': signedIn, 'GET /api/overview': overview });
  return mountAt(path);
}

describe('App shell', () => {
  it('has a skip link that moves focus to the main region', async () => {
    await mountShell('/');
    const main = document.getElementById('main')!;
    expect(main.tagName).toBe('MAIN');
    expect(main.getAttribute('tabindex')).toBe('-1');
    const skip = [...document.body.querySelectorAll('a')].find((a) => a.textContent === 'Skip to content')!;
    expect(skip.getAttribute('href')).toBe('#main');
    skip.click();
    expect(document.activeElement).toBe(main);
  });

  it('leaves focus alone on the first page, then focuses the content and announces each new page', async () => {
    const { router } = await mountShell('/');
    const main = document.getElementById('main')!;
    expect(document.activeElement).not.toBe(main);
    expect(liveRegion().textContent).toBe('');

    await router.push('/audit');
    await flushPromises();
    expect(document.activeElement).toBe(main);
    expect(liveRegion().textContent).toBe('Audit Log');
  });

  it('names endpoint pages with their slug', async () => {
    const { router } = await mountShell('/endpoints/nas/rules');
    expect(document.title).toBe('Pre-Approval Rules · /nas · Synoikia');
    await router.push('/endpoints/nas/access');
    await flushPromises();
    expect(liveRegion().textContent).toBe('Access · /nas');
  });

  it('marks the current endpoint and Settings links, and names the navigation landmarks', async () => {
    const { router } = await mountShell('/endpoints/nas/rules');
    expect(link('/nas').getAttribute('aria-current')).toBe('page');
    expect(link('Settings').hasAttribute('aria-current')).toBe(false);
    expect(document.body.querySelector('nav#app-nav')?.getAttribute('aria-label')).toBe('Main');
    expect(document.body.querySelector('nav[aria-label="Endpoint sections"]')).not.toBeNull();

    await router.push('/settings/users');
    await flushPromises();
    expect(link('Settings').getAttribute('aria-current')).toBe('page');
    expect(link('/nas').hasAttribute('aria-current')).toBe(false);
    expect(document.body.querySelector('nav[aria-label="Settings sections"]')).not.toBeNull();
  });

  it('closes the mobile menu on Escape and returns focus to its button', async () => {
    await mountShell('/');
    const menu = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Menu')!;
    expect(document.getElementById(menu.getAttribute('aria-controls')!)?.tagName).toBe('NAV');
    menu.click();
    await flushPromises();
    expect(menu.getAttribute('aria-expanded')).toBe('true');

    const audit = link('Audit Log');
    audit.focus();
    expect(press(audit, 'Escape').defaultPrevented).toBe(true);
    await flushPromises();
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(menu);
    // Closed, the menu leaves Escape to others.
    expect(press(menu, 'Escape').defaultPrevented).toBe(false);
  });

  it('announces a copy through the shared live region', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => undefined) } });
    await mountShell('/');
    const copy = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Copy URL')!;
    copy.click();
    await flushPromises();
    expect(liveRegion().textContent).toBe('Copied');
    // Outside the app root, which an open dialog makes inert.
    expect(liveRegion().parentElement).toBe(document.body);
  });
});

describe('ChipsInput', () => {
  function mountChips(initial: string[]) {
    const values = ref(initial);
    const Host = defineComponent(() => () => [
      h('div', { 'aria-live': 'polite' }, announcement.value),
      h(ChipsInput, {
        modelValue: values.value,
        'onUpdate:modelValue': (v: string[]) => (values.value = v),
        inputId: 'chips-in',
        ariaLabelledby: 'chips-label',
      }),
    ]);
    const wrapper = mount(Host, { attachTo: document.body });
    return { wrapper, values };
  }
  const removeButton = (v: string) => document.body.querySelector<HTMLButtonElement>(`[aria-label="Remove ${v}"]`)!;

  it('lists the chips and labels the input as asked', async () => {
    mountChips(['a', 'b']);
    const list = document.body.querySelector('[role="list"]')!;
    expect(list.querySelectorAll('[role="listitem"]')).toHaveLength(2);
    const input = document.getElementById('chips-in')!;
    expect(input.getAttribute('aria-labelledby')).toBe('chips-label');
  });

  it('moves focus to the next chip, then to the input, after a removal', async () => {
    const { values } = mountChips(['a', 'b']);
    removeButton('a').click();
    await flushPromises();
    expect(values.value).toEqual(['b']);
    expect(document.activeElement).toBe(removeButton('b'));

    removeButton('b').click();
    await flushPromises();
    expect(values.value).toEqual([]);
    expect(document.activeElement).toBe(document.getElementById('chips-in'));
    expect(document.body.querySelector('[role="list"]')).toBeNull();
  });

  it('announces what it adds and removes', async () => {
    const { wrapper } = mountChips(['a']);
    const input = wrapper.get('#chips-in');
    await input.setValue('b, c, a');
    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(liveRegion().textContent).toBe('Added b, c');

    removeButton('a').click();
    await flushPromises();
    expect(liveRegion().textContent).toBe('Removed a');
  });
});
