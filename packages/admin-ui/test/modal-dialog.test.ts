import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import ConfirmDialog from '../src/components/ConfirmDialog.vue';
import InfoTip from '../src/components/InfoTip.vue';
import ModalDialog from '../src/components/ModalDialog.vue';
import { provideConfirm, useConfirm } from '../src/composables/useConfirm';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
const button = (text: string) =>
  [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
const press = (target: Element, key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

/** A page with an "Open" trigger and a dialog holding a name field, an InfoTip and two buttons. */
function mountPage() {
  const root = document.createElement('div');
  root.id = 'app';
  document.body.append(root);
  const Page = defineComponent(() => {
    const open = ref(false);
    return () => [
      h('button', { type: 'button', onClick: () => (open.value = true) }, 'Open'),
      open.value &&
        h(
          ModalDialog,
          { title: 'Edit thing', onClose: () => (open.value = false) },
          {
            default: () => [
              h('input', { id: 'name' }),
              h(InfoTip, { text: 'Explains the field.', label: 'About the field' }),
            ],
            footer: () => [h('button', { type: 'button' }, 'Cancel'), h('button', { type: 'button' }, 'Save')],
          },
        ),
    ];
  });
  return mount(Page, { attachTo: root });
}

async function openDialog() {
  const wrapper = mountPage();
  const trigger = button('Open')!;
  trigger.focus();
  trigger.click();
  await flushPromises();
  return { wrapper, trigger };
}

describe('ModalDialog', () => {
  it('renders outside the page, named by its heading, and makes the page inert while open', async () => {
    const { trigger } = await openDialog();
    const d = dialog()!;
    expect(document.getElementById('app')!.contains(d)).toBe(false);
    expect(document.getElementById(d.getAttribute('aria-labelledby')!)?.textContent).toBe('Edit thing');
    expect(document.getElementById('app')!.hasAttribute('inert')).toBe(true);

    press(document.activeElement!, 'Escape');
    await flushPromises();
    expect(dialog()).toBeNull();
    expect(document.getElementById('app')!.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('moves focus to the first field and keeps Tab inside', async () => {
    await openDialog();
    const name = document.getElementById('name')!;
    expect(document.activeElement).toBe(name);

    const save = button('Save')!;
    save.focus();
    expect(press(save, 'Tab').defaultPrevented).toBe(true);
    // Wraps to the first control, the close button in the header.
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');

    expect(press(document.activeElement!, 'Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(save);

    // Between the ends, the browser moves focus as usual.
    name.focus();
    expect(press(name, 'Tab').defaultPrevented).toBe(false);
  });

  it('closes on Escape, but not on an Escape an inner control already handled', async () => {
    await openDialog();
    const name = document.getElementById('name')!;
    name.addEventListener('keydown', (e) => e.preventDefault(), { once: true });
    press(name, 'Escape');
    await flushPromises();
    expect(dialog()).not.toBeNull();

    press(name, 'Escape');
    await flushPromises();
    expect(dialog()).toBeNull();
  });

  it('keeps the draft when Escape closes an InfoTip inside it', async () => {
    await openDialog();
    const name = document.getElementById('name') as HTMLInputElement;
    name.value = 'draft';
    const tip = document.body.querySelector<HTMLButtonElement>('[aria-label="About the field"]')!;
    tip.focus();
    tip.click();
    await flushPromises();
    expect(tip.closest('.infotip')?.classList.contains('open')).toBe(true);

    press(tip, 'Escape');
    await flushPromises();
    expect(tip.closest('.infotip')?.classList.contains('open')).toBe(false);
    expect(dialog()).not.toBeNull();
    expect((document.getElementById('name') as HTMLInputElement).value).toBe('draft');
  });

  it('lets Escape hide a hovered InfoTip first, then close the dialog', async () => {
    await openDialog();
    const name = document.getElementById('name')!;
    const tip = document.body.querySelector<HTMLButtonElement>('[aria-label="About the field"]')!;
    const infotip = tip.closest('.infotip')!;
    expect(tip.hasAttribute('aria-expanded')).toBe(false);
    infotip.dispatchEvent(new MouseEvent('mouseenter'));
    await flushPromises();

    expect(press(name, 'Escape').defaultPrevented).toBe(true);
    await flushPromises();
    expect(infotip.classList.contains('dismissed')).toBe(true);
    expect(dialog()).not.toBeNull();

    press(name, 'Escape');
    await flushPromises();
    expect(dialog()).toBeNull();
  });
});

describe('useConfirm', () => {
  function mountWithConfirm() {
    let api!: ReturnType<typeof useConfirm>;
    const Child = defineComponent(() => {
      api = useConfirm();
      return () => h('button', { type: 'button' }, 'Trigger');
    });
    const Host = defineComponent(() => {
      const { request, settle } = provideConfirm();
      return () => [h(Child), request.value && h(ConfirmDialog, { request: request.value, onDone: settle })];
    });
    mount(Host, { attachTo: document.body });
    return () => api;
  }

  it('resolves a confirm with the button the user picks, and focuses Cancel first', async () => {
    const api = mountWithConfirm();
    const answer = api().confirm({ title: 'Delete the role Ops?', action: 'Delete', danger: true });
    await flushPromises();
    expect(document.getElementById(dialog()!.getAttribute('aria-labelledby')!)?.textContent).toBe(
      'Delete the role Ops?',
    );
    expect(document.activeElement?.textContent?.trim()).toBe('Cancel');
    expect(button('Delete')!.classList.contains('btn-danger')).toBe(true);
    button('Delete')!.click();
    expect(await answer).toBe(true);
    await flushPromises();
    expect(dialog()).toBeNull();

    const again = api().confirm({ title: 'Delete the role Ops?', action: 'Delete' });
    await flushPromises();
    press(document.activeElement!, 'Escape');
    expect(await again).toBe(false);
  });

  it('resolves a prompt with the typed text, or null when cancelled', async () => {
    const api = mountWithConfirm();
    const answer = api().prompt({ title: 'Rename', label: 'New name', initial: 'old', action: 'Rename' });
    await flushPromises();
    const input = document.activeElement as HTMLInputElement;
    expect(input.value).toBe('old');
    input.value = 'new';
    input.dispatchEvent(new Event('input'));
    press(input, 'Enter');
    expect(await answer).toBe('new');
    await flushPromises();

    const cancelled = api().prompt({ title: 'Rename', label: 'New name' });
    await flushPromises();
    button('Cancel')!.click();
    expect(await cancelled).toBeNull();
  });
});
