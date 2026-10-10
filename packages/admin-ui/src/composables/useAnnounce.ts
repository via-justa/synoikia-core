import { nextTick, ref } from 'vue';

const message = ref('');

/** The text of the app's one polite live region; `App.vue` renders it. */
export const announcement = message;

/** Says `text` to screen readers through the shared live region; the same text twice is said twice. */
export async function announce(text: string) {
  message.value = '';
  await nextTick();
  message.value = text;
}
