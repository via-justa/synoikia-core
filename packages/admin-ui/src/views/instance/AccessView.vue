<script setup lang="ts">
import { computed, ref } from 'vue';
import { rovingKeydown, tabStop } from '../../a11y';
import { errorText } from '../../api';
import ModalDialog from '../../components/ModalDialog.vue';
import {
  accessBase,
  useGroupsQuery,
  useLevelViewQuery,
  useMergeGroups,
  useOperationsQuery,
  useRenameGroup,
  useSetAllGroups,
  useSetGroupLevel,
  useSetOperation,
} from '../../composables/useAccess';
import type { AccessScope as Scope } from '../../composables/useAccess';
import { latestError } from '../../composables/useApiMutation';
import { useConfirm } from '../../composables/useConfirm';
import { LEVEL_HELP, LEVEL_LABELS, OP_LEVEL_HELP, REASON_LABELS, kindSource } from '../../format';
import { LEVELS } from '../../types';
import type { GroupSummary, Instance, Level, LevelView, Operation } from '../../types';

/** Access page (design §5.2.1): a level per group, and per operation a level its kind allows that
 * overrides the group (↺ resets it). Locked operations need their own Ask and never take Write.
 * With a `scope` it shows a role's maximums or the user's personal levels (design §6.4) instead. */
const props = defineProps<{
  instance: Pick<Instance, 'id' | 'slug'> & { plugin?: Pick<Instance['plugin'], 'labels' | 'attestation'> };
  scope?: Scope;
  readonly?: boolean;
}>();
const target = () => ({ instanceId: props.instance.id, scope: props.scope });
const base = computed(() => accessBase(target()));
const groupsQuery = useGroupsQuery(base, () => !props.scope);
const opsQuery = useOperationsQuery(base, () => !props.scope);
const viewQuery = useLevelViewQuery(base, () => !!props.scope);
const setGroupLevel = useSetGroupLevel(target);
const setAllGroups = useSetAllGroups(target);
const renameGroup = useRenameGroup(target);
const mergeGroups = useMergeGroups(target);
const setOperation = useSetOperation(target);
const { confirm, prompt } = useConfirm();
const opLabel = computed(() => props.instance.plugin?.labels?.operations ?? 'Operations');

const expanded = ref<Set<string>>(new Set());
const search = ref('');
const attentionOnly = ref(false);

/** A scope's level view in the shapes the endpoint view uses. */
function fromView(view: LevelView, scope: Scope) {
  const role = scope.kind === 'role';
  const opsOut = view.operations.map(
    (o) =>
      ({
        ...o,
        classification: o.classification === 'locked' ? 'write' : o.classification,
        locked: o.classification === 'locked',
        levelOverride: role ? o.roleLevel : o.ownLevel,
        level: role ? o.roleMax : o.level,
        attestationRequired: false,
        pendingReview: false,
        needsReview: false,
        inferredReason: null,
      }) as unknown as Operation,
  );
  const groupsOut: GroupSummary[] = view.groups.map((g) => {
    const mine = opsOut.filter((o) => o.group === g.key);
    return {
      key: g.key,
      label: g.label,
      level: (role ? g.roleLevel : (g.ownLevel ?? g.roleLevel)) ?? 'none',
      stale: false,
      counts: {
        read: mine.filter((o) => !o.locked && o.classification === 'read').length,
        write: mine.filter((o) => !o.locked && o.classification === 'write').length,
        locked: mine.filter((o) => o.locked).length,
        pendingReview: 0,
        overridden: mine.filter((o) => o.levelOverride !== null).length,
      },
    };
  });
  return {
    groups: groupsOut,
    ops: opsOut,
    /** The most a level can be in a scope: the endpoint's level for a role, the role's for a user. */
    caps: {
      groups: new Map(view.groups.map((g) => [g.key, role ? g.endpointLevel : (g.roleLevel ?? 'none')])),
      ops: new Map(view.operations.map((o) => [o.id, role ? o.endpointLevel : o.roleMax])),
    },
    /** Whether the scope has its own entry for the group (↺ clears it). */
    entries: new Set(view.groups.filter((g) => (role ? g.roleLevel : g.ownLevel) !== null).map((g) => g.key)),
  };
}

const levels = computed(() => {
  if (props.scope) return viewQuery.data.value ? fromView(viewQuery.data.value, props.scope) : undefined;
  if (!groupsQuery.data.value || !opsQuery.data.value) return undefined;
  return { groups: groupsQuery.data.value, ops: opsQuery.data.value, caps: undefined, entries: undefined };
});
const groups = computed(() => levels.value?.groups ?? []);
const ops = computed(() => levels.value?.ops ?? []);
const caps = computed(() => levels.value?.caps ?? { groups: new Map<string, Level>(), ops: new Map<string, Level>() });
const groupEntries = computed(() => levels.value?.entries ?? new Set<string>());

// One page alert: the latest change's failure, else a failed load.
const error = computed(() => {
  const loadError = groupsQuery.error.value ?? opsQuery.error.value ?? viewQuery.error.value;
  return (
    latestError([setGroupLevel, setAllGroups, renameGroup, setOperation]) ??
    (loadError ? errorText(loadError) : undefined)
  );
});

const text = computed(() => search.value.trim().toLowerCase());
const isWrite = (o: Operation) => o.locked || o.classification === 'write';
const needsAttention = (o: Operation) => o.pendingReview || o.needsReview;
const opsOf = (key: string) =>
  ops.value.filter(
    (o) =>
      o.group === key &&
      (!attentionOnly.value || needsAttention(o)) &&
      (!text.value ||
        o.key.toLowerCase().includes(text.value) ||
        (o.displayName ?? '').toLowerCase().includes(text.value)),
  );
const visibleGroups = computed(() =>
  groups.value.filter(
    (g) =>
      (!attentionOnly.value || opsOf(g.key).length > 0) &&
      (!text.value ||
        g.key.includes(text.value) ||
        g.label.toLowerCase().includes(text.value) ||
        opsOf(g.key).length > 0),
  ),
);
const pendingTotal = computed(() => groups.value.reduce((n, g) => n + g.counts.pendingReview, 0));

function toggle(key: string) {
  const next = new Set(expanded.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expanded.value = next;
}

// ── single-group level ──

// Levels in this order open more for one group (and, below, for one operation).
const GROUP_RANK: Record<Level, number> = { none: 0, read: 1, ask: 2, write: 3 };
const OP_RANK: Record<Level, number> = { none: 0, ask: 1, read: 2, write: 3 };
const capTitle = computed(() =>
  props.scope?.kind === 'role' ? "Above the endpoint's level" : "Above your role's maximum",
);
const groupLevelDisabled = (g: GroupSummary, l: Level) => {
  const cap = caps.value.groups.get(g.key);
  return !!props.scope && cap !== undefined && GROUP_RANK[l] > GROUP_RANK[cap];
};

const writeGroup = (key: string, level: Level | null) => setGroupLevel.mutate({ key, level });

function setLevel(group: GroupSummary, level: Level) {
  if (groupLevelDisabled(group, level)) return;
  // Clicking the current level still resets operations that have their own.
  if (level === group.level && !group.counts.overridden && (!props.scope || groupEntries.value.has(group.key))) return;
  writeGroup(group.key, level);
}

// ── bulk ──

const bulkChoice = ref('');
/** The "Set all groups…" dropdown: act on the choice, then show the prompt again. */
async function onBulkChoice() {
  const level = bulkChoice.value as Level;
  bulkChoice.value = '';
  if (!level) return;
  // One confirm because it changes every group at once, the same for every level.
  const ok = await confirm({
    title: `Set every group on /${props.instance.slug} to ${LEVEL_LABELS[level]}?`,
    message: 'Operations with their own level go back to following their group.',
    action: 'Set all groups',
  });
  if (ok) setAllGroups.mutate(level);
}

// ── regroup ──

const merging = ref<{ from: string[]; into: string; label: string; note?: string }>();
function confirmMerge() {
  const m = merging.value;
  if (!m) return;
  mergeGroups.mutate(
    { from: m.from, into: m.into.trim(), label: m.label.trim() || undefined },
    {
      onSuccess: () => (merging.value = undefined),
      onError: (err) => (merging.value = { ...m, note: errorText(err) }),
    },
  );
}
async function rename(g: GroupSummary) {
  const label = await prompt({ title: `Label for ${g.key}`, label: 'Label', initial: g.label, action: 'Rename' });
  if (label && label.trim() && label !== g.label) renameGroup.mutate({ key: g.key, label: label.trim() });
}

// ── per-operation ──

const patchOp = (op: Operation, body: Record<string, unknown>) => setOperation.mutate({ id: op.id, body });

type Kind = 'read' | 'write' | 'locked';
const kindOf = (op: Operation): Kind => (op.locked ? 'locked' : op.classification);
/** Levels shown on an operation's control: what its kind allows, plus a disabled Write on locked ones. */
const levelsShown = (op: Operation): Level[] => (op.locked ? ['none', 'ask', 'write'] : op.allowedLevels);
const levelDisabled = (op: Operation, l: Level) => {
  if (!op.allowedLevels.includes(l)) return true;
  const cap = caps.value.ops.get(op.id);
  return !!props.scope && cap !== undefined && OP_RANK[l] > OP_RANK[cap];
};

/** What the group's level means for this operation if it followed it (same rule as the server). */
function fromGroup(op: Operation, group: GroupSummary): Level {
  if (group.level === 'none' || op.locked) return 'none';
  if (!isWrite(op)) return 'read';
  return group.level === 'read' ? 'none' : group.level;
}

async function setOpLevel(op: Operation, group: GroupSummary, level: Level) {
  if (levelDisabled(op, level)) return;
  // Picking what the group already gives it just puts the operation back on the group's level.
  const own: Level | null = level === fromGroup(op, group) ? null : level;
  if (own === op.levelOverride && (own !== null || level === op.level)) return;
  if (
    own === 'ask' &&
    op.locked &&
    !(await confirm({
      title: `${op.key} is locked (destructive or irreversible).`,
      message:
        'At Ask it becomes callable: every call needs your approval on the approval page, with a typed confirmation and a fresh authenticator code. Continue?',
      action: 'Continue',
      danger: true,
    }))
  )
    return;
  patchOp(op, { level: own });
}

/** What a call does right now, in words. */
function status(op: Operation): { text: string; tone: string } {
  if (!op.reachable) return { text: REASON_LABELS[op.reason ?? ''] ?? op.reason ?? 'Off', tone: '' };
  if (op.mode === 'run') return { text: 'Runs', tone: 'ok' };
  if (op.mode === 'auto') return { text: 'Runs without asking', tone: 'danger' };
  return op.pendingReview ? { text: 'Asks until acknowledged', tone: 'warn' } : { text: 'Asks', tone: 'warn' };
}
</script>

<template>
  <div class="stack">
    <div class="row toolbar">
      <input
        v-model="search"
        class="search grow"
        :placeholder="`Search groups and ${opLabel.toLowerCase()}`"
        aria-label="Search"
      />
      <label v-if="!scope" class="row small check"
        ><input v-model="attentionOnly" type="checkbox" /> Needs attention only</label
      >
      <span class="grow" />
      <select
        v-if="!readonly && scope?.kind !== 'own'"
        v-model="bulkChoice"
        class="select bulk"
        aria-label="Set every group to one level"
        :title="`Set every group on /${instance.slug} to one level`"
        @change="onBulkChoice"
      >
        <option value="" disabled>Set all groups…</option>
        <option v-for="l in LEVELS" :key="l" :value="l">{{ LEVEL_LABELS[l] }}</option>
      </select>
      <button v-if="!scope" class="btn btn-sm" type="button" @click="merging = { from: [], into: '', label: '' }">
        Regroup…
      </button>
    </div>
    <ul class="legend small muted">
      <li v-for="l in LEVELS" :key="l">
        <strong>{{ LEVEL_LABELS[l] }}</strong
        >: {{ LEVEL_HELP[l] }}.
      </li>
      <li v-if="!readonly" class="note">
        Setting a group's level resets every {{ instance.plugin?.labels?.operation?.toLowerCase() ?? 'operation' }} in
        it to follow; ↺ puts one with its own level back.
      </li>
      <li v-if="!scope">New groups start at Ask.</li>
      <li v-else-if="scope.kind === 'role'">
        A role never goes above the endpoint's own level. Groups it has no level for, and new ones, are None.
      </li>
      <li v-else-if="!readonly">
        Your role sets the most each one can do; ↺ on a group goes back to your role's level.
      </li>
    </ul>
    <p v-if="pendingTotal" class="alert warn">
      {{ pendingTotal }} new write {{ pendingTotal === 1 ? 'operation is' : 'operations are' }} at Write but still
      {{ pendingTotal === 1 ? 'asks' : 'ask' }} for approval until you acknowledge
      {{ pendingTotal === 1 ? 'it' : 'them' }}.
    </p>
    <p v-if="error" class="alert error" role="alert">{{ error }}</p>

    <div class="table-card">
      <div v-for="g in visibleGroups" :key="g.key" class="group" :data-group="g.key">
        <div class="group-row">
          <button
            class="caret"
            type="button"
            :aria-expanded="expanded.has(g.key)"
            :aria-label="`${expanded.has(g.key) ? 'Collapse' : 'Expand'} ${g.label}`"
            @click="toggle(g.key)"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M6 3l5 5-5 5" />
            </svg>
          </button>
          <div class="grow name" @click="toggle(g.key)">
            <strong>{{ g.label }}</strong>
            <span v-if="g.label !== g.key" class="mono small muted key">{{ g.key }}</span>
            <span v-if="g.stale" class="pill">stale</span>
            <div class="small muted">
              {{ g.counts.read }} read · {{ g.counts.write }} write · {{ g.counts.locked }} locked
              <span v-if="g.counts.overridden" class="pill">{{ g.counts.overridden }} with their own level</span>
              <span v-if="g.counts.pendingReview" class="pill warn">{{ g.counts.pendingReview }} to acknowledge</span>
            </div>
          </div>
          <button v-if="!scope" class="btn-link small" type="button" @click="rename(g)">Rename</button>
          <span v-if="readonly" class="pill">{{ LEVEL_LABELS[g.level] }}</span>
          <!-- Arrows move focus only: each choice writes to the server, so Space or Enter picks it. -->
          <div
            v-else
            class="segmented"
            role="radiogroup"
            :aria-label="`Access for ${g.label}`"
            @keydown="rovingKeydown($event, false)"
          >
            <button
              v-for="l in LEVELS"
              :key="l"
              type="button"
              role="radio"
              :title="groupLevelDisabled(g, l) ? capTitle : LEVEL_HELP[l]"
              :aria-checked="g.level === l"
              :tabindex="l === tabStop(LEVELS, g.level, (x) => groupLevelDisabled(g, x)) ? 0 : -1"
              :disabled="groupLevelDisabled(g, l)"
              :class="{ on: g.level === l, write: l === 'write' }"
              @click="setLevel(g, l)"
            >
              {{ LEVEL_LABELS[l] }}
            </button>
          </div>
          <template v-if="scope && !readonly">
            <button
              v-if="groupEntries.has(g.key)"
              class="reset"
              type="button"
              :title="scope.kind === 'role' ? 'Clear: None for this role' : 'Back to your role\'s level'"
              :aria-label="`Clear the level of ${g.label}`"
              @click="writeGroup(g.key, null)"
            >
              ↺
            </button>
            <span v-else class="reset-slot" aria-hidden="true" />
          </template>
        </div>

        <div v-if="expanded.has(g.key) && opsOf(g.key).length" class="ops">
          <div v-for="op in opsOf(g.key)" :key="op.id" class="op" :data-op="op.key">
            <div class="op-name">
              <span class="mono">{{ op.key }}</span>
              <span
                v-if="op.locked"
                class="lock"
                title="Locked: destructive or irreversible"
                role="img"
                aria-label="Locked"
                >🔒</span
              >
              <div v-if="op.displayName" class="small muted">{{ op.displayName }}</div>
              <div v-if="op.description" class="small muted desc">{{ op.description }}</div>
            </div>
            <div class="op-state">
              <span
                class="pill kind"
                :class="{ danger: op.locked, warn: !op.locked && op.classification === 'write' }"
                :title="kindSource(op.inferredReason, op.locked)"
                >{{ kindOf(op) }}</span
              >
              <span class="pill status" :class="status(op).tone">{{ status(op).text }}</span>
            </div>
            <div class="controls">
              <button
                v-if="op.pendingReview"
                class="btn btn-sm btn-primary"
                type="button"
                @click="patchOp(op, { acknowledged: true })"
              >
                Acknowledge
              </button>
              <label
                v-if="!scope && instance.plugin?.attestation"
                class="row small"
                title="Calls must present the key from this operation's best-practice guide"
              >
                <input
                  type="checkbox"
                  :checked="op.attestationRequired"
                  :aria-label="`Require the guide for ${op.key}`"
                  @change="patchOp(op, { attestationRequired: ($event.target as HTMLInputElement).checked })"
                />
                Guide
              </label>
              <div
                v-if="!readonly"
                class="segmented sm"
                role="radiogroup"
                :aria-label="`Level of ${op.key}`"
                @keydown="rovingKeydown($event, false)"
              >
                <button
                  v-for="l in levelsShown(op)"
                  :key="l"
                  type="button"
                  role="radio"
                  :aria-checked="op.level === l"
                  :tabindex="l === tabStop(levelsShown(op), op.level, (x) => levelDisabled(op, x)) ? 0 : -1"
                  :disabled="levelDisabled(op, l)"
                  :title="
                    scope && op.allowedLevels.includes(l) && levelDisabled(op, l)
                      ? capTitle
                      : OP_LEVEL_HELP[kindOf(op)][l]
                  "
                  :class="{ on: op.level === l, write: l === 'write' }"
                  @click="setOpLevel(op, g, l)"
                >
                  {{ LEVEL_LABELS[l] }}<span v-if="levelDisabled(op, l)" aria-hidden="true"> 🔒</span>
                </button>
              </div>
              <button
                v-if="!readonly && op.levelOverride !== null"
                class="reset"
                type="button"
                :title="`Back to the group's level (${LEVEL_LABELS[fromGroup(op, g)]})`"
                :aria-label="`Put ${op.key} back on its group's level`"
                @click="patchOp(op, { level: null })"
              >
                ↺
              </button>
              <span v-else-if="!readonly" class="reset-slot" aria-hidden="true" />
            </div>
          </div>
        </div>
        <div v-if="expanded.has(g.key) && !opsOf(g.key).length" class="empty small">
          No matching {{ opLabel.toLowerCase() }}.
        </div>
      </div>
      <div v-if="!visibleGroups.length" class="empty">
        {{ groups.length ? 'Nothing matches.' : 'No catalog yet — sync the endpoint from the Connection tab.' }}
      </div>
    </div>

    <ModalDialog v-if="merging" title="Regroup" @close="merging = undefined">
      <p class="small muted">
        Merge groups into one control. The merged group takes the lowest of their levels. The mapping survives future
        syncs.
      </p>
      <div class="merge-list">
        <label v-for="g in groups" :key="g.key" class="row small check">
          <input v-model="merging.from" type="checkbox" :value="g.key" />
          {{ g.label }} <span class="mono muted">{{ g.key }}</span>
        </label>
      </div>
      <div class="form-grid">
        <div class="field">
          <label for="m-into">Into group key</label>
          <input id="m-into" v-model="merging.into" list="group-keys" placeholder="app" />
          <datalist id="group-keys">
            <option v-for="g in groups" :key="g.key" :value="g.key" />
          </datalist>
        </div>
        <div class="field">
          <label for="m-label">Label</label>
          <input id="m-label" v-model="merging.label" placeholder="Apps" />
        </div>
      </div>
      <p v-if="merging.note" class="alert error" role="alert">{{ merging.note }}</p>
      <template #footer>
        <button class="btn" type="button" @click="merging = undefined">Cancel</button>
        <button
          class="btn btn-primary"
          type="button"
          :disabled="!merging.from.length || !merging.into.trim()"
          @click="confirmMerge"
        >
          Merge
        </button>
      </template>
    </ModalDialog>
  </div>
</template>
<style scoped>
.legend {
  list-style: none;
  margin: 0;
  padding: 0;
}
.legend .note {
  margin-top: 6px;
}
.search {
  padding: 8px 11px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  font-size: 13px;
  min-width: 200px;
}
.check {
  gap: 6px;
  display: inline-flex;
  align-items: center;
}
.bulk {
  flex: none;
  /* Same height as the small buttons beside it. */
  padding-top: 4px;
  padding-bottom: 4px;
  font-size: 13px;
  line-height: 18px;
}
.group + .group {
  border-top: 1px solid var(--border);
}
.group-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
}
.name {
  cursor: pointer;
  min-width: 0;
}
.caret {
  -webkit-appearance: none;
  appearance: none;
  flex: none;
  width: 30px;
  height: 30px;
  margin: 0;
  padding: 0;
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-100);
  color: var(--ink);
  cursor: pointer;
}
.caret:hover {
  border-color: var(--border-strong);
}
.caret svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform 0.15s;
}
.caret[aria-expanded='true'] svg {
  transform: rotate(90deg);
}
.key {
  margin-left: 6px;
}

/* Operations sit indented under their group on their own shade, with a guide line back to it. */
.ops {
  border-top: 1px solid var(--border);
  background: var(--surface-nested);
}
.op {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 4px 14px;
  padding: 10px 14px 10px 58px;
}
.op + .op {
  border-top: 1px solid var(--border);
}
.op::before,
.op::after {
  content: '';
  position: absolute;
  left: 28px;
  background: var(--border-strong);
}
.op::before {
  top: 0;
  bottom: 0;
  width: 2px;
}
.op:last-child::before {
  bottom: 50%;
}
.op::after {
  top: 50%;
  width: 18px;
  height: 2px;
}
.op-name {
  min-width: 0;
  overflow-wrap: anywhere;
}
.desc {
  margin-top: 2px;
}
.lock {
  margin-left: 6px;
  font-size: 12px;
}
.op-state {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}
.kind {
  cursor: help;
}
.controls {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: flex-end;
}
.segmented.sm button {
  padding: 3px 10px;
  font-size: 12px;
}
.reset,
.reset-slot {
  flex: none;
  width: 26px;
  height: 26px;
}
.reset {
  -webkit-appearance: none;
  appearance: none;
  margin: 0;
  padding: 0;
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-200);
  color: var(--brand);
  font: inherit;
  font-size: 14px;
  cursor: pointer;
}
.reset:hover {
  border-color: var(--border-strong);
}
.merge-list {
  max-height: 240px;
  overflow: auto;
  margin: 8px 0 12px;
}
.merge-list > label + label {
  margin-top: 6px;
}
@media (max-width: 720px) {
  /* The spacer becomes a line break: search and the checkbox, then the bulk dropdown and Regroup. */
  .toolbar span.grow {
    flex-basis: 100%;
    height: 0;
  }
  .group-row {
    flex-wrap: wrap;
  }
  /* The name takes the first line; Rename and the level control wrap onto the next. */
  .name {
    flex: 1 1 calc(100% - 46px);
  }
  .segmented {
    margin-left: auto;
  }
  /* Operation rows stack: key and description, then kind + status, then the controls. */
  .op {
    grid-template-columns: minmax(0, 1fr);
    padding-left: 48px;
  }
  .op::before,
  .op::after {
    left: 22px;
  }
  .op-state,
  .controls {
    justify-content: flex-start;
    flex-wrap: wrap;
  }
  .controls .segmented {
    margin-left: 0;
  }
}
</style>
