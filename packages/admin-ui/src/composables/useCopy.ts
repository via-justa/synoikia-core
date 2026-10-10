import { ref } from 'vue';
import { announce } from './useAnnounce';

/** Copies text to the clipboard; `copied` holds that text for 1.5 s so its button can say so. */
export function useCopy() {
  const copied = ref<string>();
  async function copy(text: string) {
    await navigator.clipboard?.writeText(text).catch(() => undefined);
    copied.value = text;
    void announce('Copied');
    setTimeout(() => (copied.value = undefined), 1500);
  }
  return { copied, copy };
}
