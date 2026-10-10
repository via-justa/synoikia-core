<script setup lang="ts">
import { ref, useId } from 'vue';

/** A small "?" that explains a setting: shows on hover and keyboard focus, and toggles on tap. */
defineProps<{ text: string; label?: string; end?: boolean }>();
const id = useId();
const open = ref(false);
</script>

<template>
  <span class="infotip" :class="{ open, end }" @mouseleave="open = false">
    <button
      type="button"
      class="mark"
      :aria-label="label ?? 'More information'"
      :aria-describedby="id"
      :aria-expanded="open"
      @click.prevent="open = !open"
      @blur="open = false"
      @keydown.esc.prevent="open = false"
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
  pointer-events: none;
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
</style>
