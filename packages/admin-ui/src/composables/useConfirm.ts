import { inject, provide, shallowRef } from 'vue';
import type { InjectionKey, ShallowRef } from 'vue';

export interface ConfirmOptions {
  title: string;
  message?: string;
  /** The confirm button's label. */
  action?: string;
  danger?: boolean;
}

export interface PromptOptions extends ConfirmOptions {
  label: string;
  initial?: string;
}

export interface ConfirmRequest extends ConfirmOptions {
  input?: { label: string; value: string };
  /** The typed text, '' for a confirm, or null when cancelled. */
  resolve: (value: string | null) => void;
}

const KEY: InjectionKey<ShallowRef<ConfirmRequest | undefined>> = Symbol('confirm');

/** Called once by `App.vue`, which renders the pending request in `ConfirmDialog` and settles it. */
export function provideConfirm() {
  const request = shallowRef<ConfirmRequest>();
  provide(KEY, request);
  function settle(value: string | null) {
    const r = request.value;
    request.value = undefined;
    r?.resolve(value);
  }
  return { request, settle };
}

/** Promise-based replacements for the browser's confirm and prompt dialogs. */
export function useConfirm() {
  const request = inject(KEY);
  if (!request) throw new Error('useConfirm needs provideConfirm() in App.vue');

  function open(options: ConfirmOptions, input?: ConfirmRequest['input']) {
    request!.value?.resolve(null);
    return new Promise<string | null>((resolve) => {
      request!.value = { ...options, input, resolve };
    });
  }

  return {
    confirm: async (options: ConfirmOptions) => (await open(options)) !== null,
    prompt: (options: PromptOptions) => open(options, { label: options.label, value: options.initial ?? '' }),
  };
}
