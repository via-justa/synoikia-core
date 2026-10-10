<script setup lang="ts">
import { onBeforeUnmount, onMounted, useId, useTemplateRef } from 'vue';

defineProps<{ title: string; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();

const titleId = useId();
const panel = useTemplateRef<HTMLElement>('panel');
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const me = Symbol();
let opener: HTMLElement | null = null;

const focusables = (root: ParentNode | null | undefined) => [...(root?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];

function onKey(e: KeyboardEvent) {
  // A key an inner control already handled (an open tip, a chip input) is not for the dialog.
  if (stack.at(-1) !== me || e.defaultPrevented) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
  } else if (e.key === 'Tab') {
    const items = focusables(panel.value);
    const first = items[0];
    const last = items.at(-1);
    const inside = panel.value?.contains(document.activeElement) ?? false;
    if (!first || !last) {
      e.preventDefault();
    } else if (e.shiftKey && (!inside || document.activeElement === first)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
      e.preventDefault();
      first.focus();
    }
  }
}

onMounted(() => {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (!stack.length) document.getElementById('app')?.setAttribute('inert', '');
  stack.push(me);
  document.addEventListener('keydown', onKey);
  const p = panel.value;
  const target =
    p?.querySelector<HTMLElement>('[autofocus]') ??
    focusables(p?.querySelector('.body'))[0] ??
    focusables(p?.querySelector('footer'))[0] ??
    focusables(p)[0];
  target?.focus();
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey);
  stack.splice(stack.indexOf(me), 1);
  if (!stack.length) document.getElementById('app')?.removeAttribute('inert');
  if (opener?.isConnected) opener.focus();
});
</script>

<script lang="ts">
// Open dialogs, innermost last; only the innermost answers keys.
const stack: symbol[] = [];
</script>

<template>
  <Teleport to="body">
    <div class="backdrop" @click.self="emit('close')">
      <div ref="panel" class="modal card" :class="{ wide }" role="dialog" aria-modal="true" :aria-labelledby="titleId">
        <header>
          <h2 :id="titleId">{{ title }}</h2>
          <button class="close" type="button" aria-label="Close" @click="emit('close')">×</button>
        </header>
        <div class="body"><slot /></div>
        <footer v-if="$slots.footer" class="actions"><slot name="footer" /></footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgb(36 27 18 / 45%);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 8vh 16px 16px;
  z-index: 50;
  overflow: auto;
}
.modal {
  width: 100%;
  max-width: 520px;
}
.modal.wide {
  max-width: 760px;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
header h2 {
  margin: 0;
}
.close {
  border: none;
  background: none;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  color: var(--ink-muted);
}
footer {
  justify-content: flex-end;
  margin-top: 18px;
}
</style>
