<script setup lang="ts">
import { computed, ref } from 'vue';
import { LEVEL_HELP, LEVEL_LABELS, REASON_LABELS } from '../format';
import { LEVELS } from '../types';
import type { Level, LevelView } from '../types';

/** Levels on top of an endpoint's (design §5.2.1): a role's maximums (`layer: 'role'`) or a user's
 * own levels (`layer: 'own'`). Without `editable` it only shows what is in force. */
const props = defineProps<{ view: LevelView; layer: 'role' | 'own'; editable: boolean }>();
const emit = defineEmits<{
  setGroup: [key: string, level: Level | null];
  setOp: [id: string, level: Level | null];
}>();

type Op = LevelView['operations'][number];

// Groups: None < Read < Ask < Write. For one operation, Ask is tighter than running.
const GROUP_RANK: Record<Level, number> = { none: 0, read: 1, ask: 2, write: 3 };
const OP_RANK: Record<Level, number> = { none: 0, ask: 1, read: 2, write: 3 };

const expanded = ref<Set<string>>(new Set());
function toggle(key: string) {
  const next = new Set(expanded.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expanded.value = next;
}

const opsOf = (key: string) => props.view.operations.filter((o) => o.group === key);
/** What this layer may go up to: the endpoint's level for a role, the role's for a user. */
const groupCap = (g: LevelView['groups'][number]) =>
  props.layer === 'role' ? g.endpointLevel : (g.roleLevel ?? 'none');
const groupValue = (g: LevelView['groups'][number]) => (props.layer === 'role' ? g.roleLevel : g.ownLevel);
const opCap = (o: Op) => (props.layer === 'role' ? o.endpointLevel : o.roleMax);
const opValue = (o: Op) => (props.layer === 'role' ? o.roleLevel : o.ownLevel);

const what = (o: Op) =>
  !o.reachable
    ? (REASON_LABELS[o.reason ?? ''] ?? 'Off')
    : o.mode === 'approve'
      ? 'Asks for approval'
      : o.mode === 'auto'
        ? 'Runs without a question'
        : 'Runs';

const unsetLabel = computed(() => (props.layer === 'role' ? 'Not set (None)' : 'Follow role'));

function onGroup(key: string, e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  emit('setGroup', key, v === '' ? null : (v as Level));
}
function onOp(id: string, e: Event) {
  const v = (e.target as HTMLSelectElement).value;
  emit('setOp', id, v === '' ? null : (v as Level));
}
</script>

<template>
  <div class="table-card">
    <div v-if="view.groups.length === 0" class="empty muted">Nothing to show on this endpoint.</div>
    <div v-for="g in view.groups" :key="g.key" class="group" :data-group="g.key">
      <div class="group-row">
        <button
          class="caret"
          type="button"
          :aria-expanded="expanded.has(g.key)"
          :aria-label="`${expanded.has(g.key) ? 'Collapse' : 'Expand'} ${g.label}`"
          @click="toggle(g.key)"
        >
          {{ expanded.has(g.key) ? '▾' : '▸' }}
        </button>
        <div class="grow name" @click="toggle(g.key)">
          <strong>{{ g.label }}</strong>
          <span v-if="g.label !== g.key" class="mono small muted"> {{ g.key }}</span>
          <div class="small muted">
            Endpoint: {{ LEVEL_LABELS[g.endpointLevel] }}
            <template v-if="layer === 'own'"> · Role maximum: {{ LEVEL_LABELS[g.roleLevel ?? 'none'] }}</template>
          </div>
        </div>
        <select
          v-if="editable"
          class="select"
          :value="groupValue(g) ?? ''"
          :aria-label="`Level of ${g.label}`"
          @change="onGroup(g.key, $event)"
        >
          <option value="">{{ unsetLabel }}</option>
          <option
            v-for="l in LEVELS"
            :key="l"
            :value="l"
            :disabled="GROUP_RANK[l] > GROUP_RANK[groupCap(g)]"
            :title="LEVEL_HELP[l]"
          >
            {{ LEVEL_LABELS[l] }}
          </option>
        </select>
        <span v-else class="pill">{{
          LEVEL_LABELS[groupValue(g) ?? (layer === 'own' ? (g.roleLevel ?? 'none') : 'none')]
        }}</span>
      </div>
      <table v-if="expanded.has(g.key)" class="table ops">
        <tbody>
          <tr v-for="o in opsOf(g.key)" :key="o.id" :data-op="o.key">
            <td>
              <span class="mono">{{ o.key }}</span>
              <span v-if="o.classification !== 'read'" class="pill" :class="{ danger: o.classification === 'locked' }">
                {{ o.classification }}
              </span>
              <div v-if="o.displayName || o.description" class="small muted">
                {{ o.displayName ?? o.description }}
              </div>
            </td>
            <td class="small">
              <strong>{{ LEVEL_LABELS[o.level] }}</strong> · {{ what(o) }}
              <div class="muted">at most {{ LEVEL_LABELS[opCap(o)] }}</div>
            </td>
            <td class="ctl">
              <select
                v-if="editable"
                class="select"
                :value="opValue(o) ?? ''"
                :aria-label="`Level of ${o.key}`"
                @change="onOp(o.id, $event)"
              >
                <option value="">Follow group</option>
                <option v-for="l in o.allowedLevels" :key="l" :value="l" :disabled="OP_RANK[l] > OP_RANK[opCap(o)]">
                  {{ LEVEL_LABELS[l] }}
                </option>
              </select>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.group + .group {
  border-top: 1px solid var(--border);
}
.group-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
}
.name {
  cursor: pointer;
}
.caret {
  background: none;
  border: 0;
  cursor: pointer;
  color: var(--text-muted);
  width: 20px;
}
.ops td {
  vertical-align: top;
}
.ops td:first-child {
  padding-left: 48px;
}
.ctl {
  text-align: right;
}
.empty {
  padding: 16px;
}
</style>
