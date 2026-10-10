<script setup lang="ts">
import { computed, useId } from 'vue';
import type { ConnectionSchema, JsonSchemaProp, UiHint } from '../types';

/** Renders a plugin's connection schema (design §8.3). Secrets are never shown, only set/replace/clear;
 * `secretPatch` follows the API merge rules: omitted keeps, null clears. */
const props = defineProps<{
  schema: ConnectionSchema;
  ui: Record<string, UiHint>;
  secrets?: Record<string, { set: boolean; hint?: string }>;
}>();
const config = defineModel<Record<string, unknown>>('config', { required: true });
const secretPatch = defineModel<Record<string, string | null>>('secretPatch', { default: () => ({}) });
const uid = useId();

interface FieldView {
  name: string;
  prop: JsonSchemaProp;
  hint: UiHint;
  widget: string;
  label: string;
  required: boolean;
  secret: boolean;
}

function widgetFor(prop: JsonSchemaProp, hint: UiHint): string {
  if (hint.widget) return hint.widget;
  if (prop.writeOnly) return 'secret';
  if (prop.enum) return 'select';
  const type = Array.isArray(prop.type) ? prop.type.find((t) => t !== 'null') : prop.type;
  if (type === 'boolean') return 'bool';
  if (type === 'integer' || type === 'number') return 'number';
  if (type === 'array' && prop.items?.enum) return 'multiselect';
  if (prop.format === 'uri' || prop.format === 'url') return 'url';
  return 'text';
}

const fields = computed<FieldView[]>(() =>
  Object.entries(props.schema.properties ?? {}).map(([name, prop]) => {
    const hint = props.ui[name] ?? {};
    const widget = widgetFor(prop, hint);
    return {
      name,
      prop,
      hint,
      widget,
      label: prop.title ?? name,
      required: props.schema.required?.includes(name) ?? false,
      secret: widget === 'secret' || prop.writeOnly === true,
    };
  }),
);

const helpOf = (f: FieldView) => f.hint.help ?? f.prop.description;
const helpId = (f: FieldView) => (helpOf(f) ? `${uid}-${f.name}-help` : undefined);

const visible = (f: FieldView) => {
  const when = f.hint.showWhen;
  if (!when) return true;
  const current = config.value[when.field] ?? props.schema.properties?.[when.field]?.default;
  return when.in.includes(current as string | number | boolean);
};

function set(name: string, value: unknown) {
  config.value = { ...config.value, [name]: value };
}
function setNumber(name: string, raw: string) {
  set(name, raw === '' ? undefined : Number(raw));
}
function toggleMulti(name: string, option: unknown, on: boolean) {
  const current = Array.isArray(config.value[name]) ? (config.value[name] as unknown[]) : [];
  set(name, on ? [...current, option] : current.filter((v) => v !== option));
}

const secretState = (name: string) => {
  if (name in secretPatch.value) return secretPatch.value[name] === null ? 'clearing' : 'editing';
  return props.secrets?.[name]?.set ? 'set' : 'unset';
};
function editSecret(name: string) {
  secretPatch.value = { ...secretPatch.value, [name]: '' };
}
function clearSecret(name: string) {
  secretPatch.value = { ...secretPatch.value, [name]: null };
}
function keepSecret(name: string) {
  const next = { ...secretPatch.value };
  delete next[name];
  secretPatch.value = next;
}
function setSecret(name: string, value: string) {
  secretPatch.value = { ...secretPatch.value, [name]: value };
}
</script>

<template>
  <div class="schema-form">
    <template v-for="f in fields" :key="f.name">
      <div v-if="visible(f)" class="field" :class="{ check: f.widget === 'bool' }" :data-field="f.name">
        <template v-if="f.widget === 'bool'">
          <label>
            <input
              type="checkbox"
              :aria-describedby="helpId(f)"
              :checked="Boolean(config[f.name] ?? f.prop.default)"
              @change="set(f.name, ($event.target as HTMLInputElement).checked)"
            />
            {{ f.label }}
          </label>
        </template>
        <template v-else>
          <label :id="`${uid}-${f.name}`" :for="`f-${f.name}`"
            >{{ f.label }}<span v-if="f.required" class="req"> *</span></label
          >

          <template v-if="f.secret">
            <div
              v-if="secretState(f.name) === 'set'"
              class="row"
              role="group"
              :aria-labelledby="`${uid}-${f.name}`"
              :aria-describedby="helpId(f)"
            >
              <span class="pill ok">Set{{ secrets?.[f.name]?.hint ? ` · ${secrets[f.name]!.hint}` : '' }}</span>
              <button type="button" class="btn btn-sm" @click="editSecret(f.name)">Replace</button>
              <button type="button" class="btn btn-sm btn-danger" @click="clearSecret(f.name)">Clear</button>
            </div>
            <div
              v-else-if="secretState(f.name) === 'clearing'"
              class="row"
              role="group"
              :aria-labelledby="`${uid}-${f.name}`"
              :aria-describedby="helpId(f)"
            >
              <span class="pill warn">Will be cleared</span>
              <button type="button" class="btn btn-sm" @click="keepSecret(f.name)">Undo</button>
            </div>
            <div v-else class="row">
              <input
                :id="`f-${f.name}`"
                class="grow"
                type="password"
                autocomplete="new-password"
                :aria-describedby="helpId(f)"
                :placeholder="f.hint.placeholder ?? (secretState(f.name) === 'editing' ? 'New value' : 'Not set')"
                :value="secretPatch[f.name] ?? ''"
                @input="setSecret(f.name, ($event.target as HTMLInputElement).value)"
              />
              <button v-if="secrets?.[f.name]?.set" type="button" class="btn btn-sm" @click="keepSecret(f.name)">
                Keep current
              </button>
            </div>
          </template>

          <select
            v-else-if="f.widget === 'select'"
            :id="`f-${f.name}`"
            :aria-describedby="helpId(f)"
            :value="config[f.name] ?? f.prop.default ?? ''"
            @change="set(f.name, ($event.target as HTMLSelectElement).value)"
          >
            <option v-if="!f.required" value="">—</option>
            <option v-for="opt in f.prop.enum ?? []" :key="String(opt)" :value="opt">{{ opt }}</option>
          </select>

          <div
            v-else-if="f.widget === 'multiselect'"
            class="row"
            role="group"
            :aria-labelledby="`${uid}-${f.name}`"
            :aria-describedby="helpId(f)"
          >
            <label v-for="opt in f.prop.items?.enum ?? []" :key="String(opt)" class="multi">
              <input
                type="checkbox"
                :checked="Array.isArray(config[f.name]) && (config[f.name] as unknown[]).includes(opt)"
                @change="toggleMulti(f.name, opt, ($event.target as HTMLInputElement).checked)"
              />
              {{ opt }}
            </label>
          </div>

          <input
            v-else-if="f.widget === 'number'"
            :id="`f-${f.name}`"
            type="number"
            :aria-describedby="helpId(f)"
            :min="f.prop.minimum"
            :max="f.prop.maximum"
            :placeholder="f.hint.placeholder ?? (f.prop.default !== undefined ? String(f.prop.default) : '')"
            :value="config[f.name] ?? ''"
            @input="setNumber(f.name, ($event.target as HTMLInputElement).value)"
          />

          <input
            v-else
            :id="`f-${f.name}`"
            :type="f.widget === 'url' ? 'url' : 'text'"
            :aria-describedby="helpId(f)"
            :placeholder="f.hint.placeholder ?? (f.prop.default !== undefined ? String(f.prop.default) : '')"
            :value="config[f.name] ?? ''"
            @input="set(f.name, ($event.target as HTMLInputElement).value || undefined)"
          />
        </template>
        <p v-if="helpOf(f)" :id="helpId(f)" class="help">{{ helpOf(f) }}</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.req {
  color: var(--danger-text);
}
.multi {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 13px;
  font-weight: 500;
  color: var(--ink);
  margin: 0;
}
.multi input {
  width: auto;
}
</style>
