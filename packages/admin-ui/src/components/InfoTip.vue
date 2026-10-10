<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useId, useTemplateRef } from 'vue';

/** A small "?" that explains a setting: shows on hover and keyboard focus, and toggles on tap. Escape hides it. */
defineProps<{ text: string; label?: string; end?: boolean }>();
const id = useId();
const open = ref(false);
const hovered = ref(false);
const dismissed = ref(false);
const mark = useTemplateRef<HTMLButtonElement>('mark');

function keyboardFocused() {
  const el = mark.value;
  if (el !== document.activeElement) return false;
  try {
    return el?.matches(':focus-visible') ?? false;
  } catch {
    return true;
  }
}
// Capture phase, so an open tip takes Escape before an enclosing dialog does.
function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented || dismissed.value) return;
  if (!open.value && !hovered.value && !keyboardFocused()) return;
  e.preventDefault();
  open.value = false;
  dismissed.value = true;
}
function toggle() {
  dismissed.value = false;
  open.value = !open.value;
}
function hide() {
  open.value = false;
  dismissed.value = false;
}
function leave() {
  hovered.value = false;
  hide();
}

onMounted(() => window.addEventListener('keydown', onKey, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));
</script>

<template>
  <span class="infotip" :class="{ open, end, dismissed }" @mouseenter="hovered = true" @mouseleave="leave">
    <button
      ref="mark"
      type="button"
      class="mark"
      :aria-label="label ?? 'More information'"
      :aria-describedby="id"
      @click.prevent="toggle"
      @blur="hide"
    >
      ?
    </button>
    <span :id="id" role="tooltip" class="bubble">{{ text }}</span>
  </span>
</template>

<style scoped>
.infotip {
  position: relative;
  display: inline-block;
  vertical-align: middle;
  margin-left: 6px;
}
.mark {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  margin: 0;
  padding: 0;
  display: grid;
  place-items: center;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-full);
  background: var(--surface-100);
  color: var(--ink-muted);
  font: 600 11px/1 var(--font-sans);
  cursor: help;
}
.mark:hover,
.open .mark {
  color: var(--ink);
  border-color: var(--ink-muted);
}
.bubble {
  position: absolute;
  z-index: 60;
  top: calc(100% + 6px);
  left: -8px;
  width: max-content;
  max-width: min(300px, 70vw);
  padding: 8px 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  background: var(--surface-100);
  box-shadow: var(--shadow-md);
  color: var(--ink);
  font: 400 13px/19px var(--font-sans);
  text-transform: none;
  letter-spacing: normal;
  white-space: normal;
  visibility: hidden;
  opacity: 0;
  transition: opacity 0.1s;
}
/* Bridges the gap above the bubble, so the pointer can move onto it. */
.bubble::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: -7px;
  height: 7px;
}
.end .bubble {
  left: auto;
  right: -8px;
}
.infotip:hover .bubble,
.mark:focus-visible + .bubble,
.open .bubble {
  visibility: visible;
  opacity: 1;
}
.infotip.dismissed .bubble {
  visibility: hidden;
  opacity: 0;
}
</style>
