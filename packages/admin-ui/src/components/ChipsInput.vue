<script setup lang="ts">
import { nextTick, ref, useTemplateRef } from 'vue';
import { announce } from '../composables/useAnnounce';

/** A list of strings edited as chips; Enter or comma adds, × removes. Optional suggestions. */
const props = defineProps<{
  placeholder?: string;
  suggestions?: { value: string; label: string }[];
  inputId?: string;
  ariaLabelledby?: string;
  ariaDescribedby?: string;
}>();
const model = defineModel<string[]>({ required: true });
const draft = ref('');
const listId = `chips-${Math.random().toString(36).slice(2)}`;
const root = useTemplateRef<HTMLElement>('root');

function add(raw = draft.value) {
  const values = raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const next = [...model.value];
  const added = values.filter((v, i) => !next.includes(v) && values.indexOf(v) === i);
  next.push(...added);
  model.value = next;
  draft.value = '';
  if (added.length) void announce(`Added ${added.map(labelOf).join(', ')}`);
}
// Focus stays in the list: the next chip's remove button, else the input.
async function remove(v: string) {
  const index = model.value.indexOf(v);
  model.value = model.value.filter((x) => x !== v);
  void announce(`Removed ${labelOf(v)}`);
  await nextTick();
  const target = root.value?.querySelectorAll<HTMLElement>('.chip button')[index] ?? root.value?.querySelector('input');
  target?.focus();
}
const labelOf = (v: string) => props.suggestions?.find((s) => s.value === v)?.label ?? v;
</script>

<template>
  <div ref="root" class="chips">
    <span v-if="model.length" role="list" class="list">
      <span v-for="v in model" :key="v" role="listitem" class="chip">
        {{ labelOf(v) }}
        <button type="button" :aria-label="`Remove ${v}`" @click="remove(v)">×</button>
      </span>
    </span>
    <input
      :id="inputId"
      v-model="draft"
      :aria-labelledby="ariaLabelledby"
      :aria-describedby="ariaDescribedby"
      :placeholder="placeholder"
      :list="suggestions?.length ? listId : undefined"
      @keydown.enter.prevent="add()"
      @keydown.,.prevent="add()"
      @change="suggestions?.some((s) => s.value === draft) && add()"
      @blur="draft && add()"
    />
    <datalist v-if="suggestions?.length" :id="listId">
      <option v-for="s in suggestions" :key="s.value" :value="s.value">{{ s.label }}</option>
    </datalist>
  </div>
</template>

<style scoped>
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  background: var(--surface-100);
}
.chips:focus-within {
  outline: 2px solid var(--focus-ring);
  outline-offset: -1px;
  border-color: var(--focus-ring);
}
.list {
  display: contents;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  background: var(--accent-subtle);
  color: var(--accent-strong);
  border-radius: var(--radius-full);
  padding: 2px 4px 2px 9px;
}
.chip button {
  border: none;
  background: none;
  cursor: pointer;
  color: inherit;
  font-size: 14px;
  line-height: 1;
}
input {
  flex: 1;
  min-width: 120px;
  border: none !important;
  background: transparent !important;
  padding: 4px !important;
  font-size: 13px;
}
.chips input:focus {
  outline: none;
}
</style>
