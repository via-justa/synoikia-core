<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRegistryKinds, useRegistrySearch } from '../composables/useRegistry';
import type { TargetFieldOptions, TargetsDecl } from '../types';
import ChipsInput from './ChipsInput.vue';

/** `$targets` selector (design §8.3), from the plugin's targets and scopes; values are suggested
 * from the synced registry where the plugin names a kind, else free text. */
/** `base`: the API prefix, `/api/instances/:id` for an admin or `/api/me/endpoints/:id` for own rules. */
const props = defineProps<{ base: string; targets: TargetsDecl; options?: TargetFieldOptions }>();
const model = defineModel<{ ids: string[]; scopes: Record<string, string[]> }>({ required: true });

const scopes = computed(() =>
  props.targets.scopes.filter((s) => !props.options?.scopes || props.options.scopes.includes(s.key)),
);
const idQuery = ref('');
const searchText = ref('');
const filter = computed(() =>
  Object.fromEntries(Object.entries(props.options?.filter ?? {}).map(([k, v]) => [`scope.${k}`, v])),
);

const kindOptions = useRegistryKinds(
  () => props.base,
  () => scopes.value.flatMap((s) => (s.registryKind ? [s.registryKind] : [])),
);
const scopeOptions = computed(() =>
  Object.fromEntries(scopes.value.flatMap((s) => (s.registryKind ? [[s.key, kindOptions.value[s.registryKind]]] : []))),
);
const idSearch = useRegistrySearch(
  () => props.base,
  () => {
    const kind = props.targets.registryKind;
    return kind ? { kind, text: searchText.value, limit: 50, ...filter.value } : undefined;
  },
);
const idOptions = computed(() => idSearch.data.value ?? []);
let t: ReturnType<typeof setTimeout> | undefined;
watch(idQuery, (q) => {
  clearTimeout(t);
  t = setTimeout(() => (searchText.value = q), 200);
});

function setScope(key: string, values: string[]) {
  const next = { ...model.value.scopes };
  if (values.length) next[key] = values;
  else delete next[key];
  model.value = { ...model.value, scopes: next };
}
</script>

<template>
  <div class="picker">
    <div v-for="s in scopes" :key="s.key" class="field">
      <label>{{ s.label }}</label>
      <ChipsInput
        :model-value="model.scopes[s.key] ?? []"
        :suggestions="scopeOptions[s.key]"
        :placeholder="`Add a ${s.label.toLowerCase()}`"
        @update:model-value="(values: string[]) => setScope(s.key, values)"
      />
    </div>
    <div class="field">
      <label>{{ targets.label }}</label>
      <input
        v-if="targets.registryKind"
        v-model="idQuery"
        class="search"
        :placeholder="`Search ${targets.label.toLowerCase()}…`"
        :aria-label="`Search ${targets.label.toLowerCase()}`"
      />
      <ChipsInput
        v-model="model.ids"
        :suggestions="targets.registryKind ? idOptions : undefined"
        :placeholder="`Add a ${targets.label.toLowerCase()}`"
      />
    </div>
    <p class="help">Every resolved target must fall inside all the filters you set.</p>
  </div>
</template>

<style scoped>
.picker {
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-md);
  padding: 10px 12px 2px;
}
.search {
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  margin-bottom: 6px;
  font-size: 13px;
}
.help {
  font-size: 12px;
  color: var(--ink-muted);
}
</style>
