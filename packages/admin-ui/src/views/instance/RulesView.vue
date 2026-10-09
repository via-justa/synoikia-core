<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { errorText, http } from '../../api';
import ChipsInput from '../../components/ChipsInput.vue';
import InfoTip from '../../components/InfoTip.vue';
import ModalDialog from '../../components/ModalDialog.vue';
import RegistryPicker from '../../components/RegistryPicker.vue';
import { REASON_LABELS, ago, formatDate } from '../../format';
import type {
  Instance,
  LevelView,
  MatchCondition,
  MatchField,
  Operation,
  PluginRow,
  Rule,
  TargetFieldOptions,
  TargetsDecl,
} from '../../types';

/** Pre-approval rules (design §5.2): a catalog operation (never locked), a match from its declared
 * fields, a required reason, optional rate limit and expiry. */
const props = defineProps<{
  instance: Pick<Instance, 'id'> & { plugin?: Pick<Instance['plugin'], 'id'> };
  own?: boolean;
}>();
// `own`: a user's own rules on `/api/me` (design §6.4); admin rules show there read-only.
const base = computed(() =>
  props.own ? `/api/me/endpoints/${props.instance.id}` : `/api/instances/${props.instance.id}`,
);

const rules = ref<Rule[]>([]);
const ops = ref<Operation[]>([]);
const profiles = ref<Record<string, MatchField[]>>({});
const targets = ref<TargetsDecl>();
const error = ref<string>();

async function load() {
  try {
    if (props.own) {
      const [r, view, form] = await Promise.all([
        http.get<Rule[]>(`${base.value}/rules`),
        http.get<LevelView>(`${base.value}/access`),
        http.get<{ matchProfiles: Record<string, MatchField[]>; targets: TargetsDecl | null }>(
          `${base.value}/rule-form`,
        ),
      ]);
      rules.value = r;
      ops.value = view.operations.map(
        (o) =>
          ({
            ...o,
            classification: o.classification === 'locked' ? 'write' : o.classification,
            locked: o.classification === 'locked',
          }) as unknown as Operation,
      );
      profiles.value = form.matchProfiles;
      targets.value = form.targets ?? undefined;
      return;
    }
    const [r, o, plugins] = await Promise.all([
      http.get<Rule[]>(`${base.value}/rules`),
      http.get<Operation[]>(`${base.value}/operations`),
      http.get<PluginRow[]>('/api/plugins'),
    ]);
    rules.value = r;
    ops.value = o;
    const manifest = plugins.find((p) => p.id === props.instance.plugin?.id)?.manifest;
    profiles.value = manifest?.matchProfiles ?? {};
    targets.value = manifest?.targets;
  } catch (err) {
    error.value = errorText(err);
  }
}
onMounted(load);

const eligible = computed(() => ops.value.filter((o) => o.classification === 'write' && !o.locked));

// ── editor ──

interface FieldValue {
  text: string;
  list: string[];
  min: string;
  max: string;
  bool: boolean | null;
  /** Accept any value for this parameter (or its absence) instead of constraining it. */
  any: boolean;
  targets: { ids: string[]; scopes: Record<string, string[]> };
}
interface Draft {
  id?: string;
  operationId: string;
  values: Record<string, FieldValue>;
  /** Other parameters (JSON pointers) accepted with any value. */
  extraAny: string[];
  /** Accept any parameters at all (`{ field: '', op: 'any' }`). */
  anyParams: boolean;
  rateLimit: string;
  windowMinutes: string;
  expiresAt: string;
  reason: string;
  enabled: boolean;
  note?: string;
}
const draft = ref<Draft>();
const options = ref<Record<string, { value: string; label: string }[]>>({});

const emptyValue = (): FieldValue => ({
  text: '',
  list: [],
  min: '',
  max: '',
  bool: null,
  any: false,
  targets: { ids: [], scopes: {} },
});
const draftOp = computed(() => ops.value.find((o) => o.id === draft.value?.operationId));
const fields = computed<MatchField[]>(() =>
  draftOp.value?.matchProfile ? (profiles.value[draftOp.value.matchProfile] ?? []) : [],
);

watch(fields, async (fs) => {
  for (const f of fs) {
    if (f.optionsSource && !options.value[f.optionsSource]) {
      const opts = await http
        .get<{ value: string; label: string }[]>(`${base.value}/options/${f.optionsSource}`)
        .catch(() => []);
      options.value = { ...options.value, [f.optionsSource]: opts };
    }
  }
});

function localDateTime(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function edit(rule?: Rule) {
  const values: Record<string, FieldValue> = {};
  const extraAny: string[] = [];
  let anyParams = false;
  const profile = rule?.operation.matchProfile ? (profiles.value[rule.operation.matchProfile] ?? []) : [];
  for (const c of rule?.match ?? []) {
    if (c.field !== '$targets' && 'op' in c && c.op === 'any') {
      if (c.field === '') anyParams = true;
      else if (profile.some((f) => f.field === c.field)) values[c.field] = { ...emptyValue(), any: true };
      else extraAny.push(c.field);
      continue;
    }
    const v = emptyValue();
    if (c.field === '$targets') {
      const t = c as { ids?: string[]; scopes?: Record<string, string[]> };
      v.targets = { ids: t.ids ?? [], scopes: { ...t.scopes } };
    } else {
      const pc = c as { op: string; value: unknown };
      if (pc.op === 'in') v.list = (pc.value as unknown[]).map(String);
      else if (pc.op === 'range') {
        const r = pc.value as { min?: number; max?: number };
        v.min = r.min?.toString() ?? '';
        v.max = r.max?.toString() ?? '';
      } else if (pc.op === 'bool') v.bool = pc.value as boolean;
      else v.text = String(pc.value ?? '');
    }
    values[c.field] = v;
  }
  draft.value = {
    id: rule?.id,
    operationId: rule?.operationId ?? '',
    values,
    extraAny,
    anyParams,
    rateLimit: rule?.rateLimit?.toString() ?? '',
    windowMinutes: rule?.windowSeconds ? String(rule.windowSeconds / 60) : '',
    expiresAt: localDateTime(rule?.expiresAt ?? null),
    reason: rule?.reason ?? '',
    enabled: rule?.enabled ?? true,
  };
}
const targetOptions = (f: MatchField) => f.options as TargetFieldOptions | undefined;
const valueOf = (f: MatchField) => {
  const d = draft.value!;
  if (!d.values[f.field]) d.values[f.field] = emptyValue();
  return d.values[f.field]!;
};

function buildMatch(): MatchCondition[] {
  const out: MatchCondition[] = [];
  for (const f of fields.value) {
    const v = draft.value!.values[f.field];
    if (!v) continue;
    if (f.field === '$targets') {
      const t = v.targets;
      const scopes = Object.fromEntries(Object.entries(t.scopes).filter(([, values]) => values.length));
      if (t.ids.length || Object.keys(scopes).length) {
        out.push({
          field: '$targets',
          ...(t.ids.length ? { ids: t.ids } : {}),
          ...(Object.keys(scopes).length ? { scopes } : {}),
        });
      }
      continue;
    }
    const op = f.op!;
    if (v.any) out.push({ field: f.field, op: 'any' });
    else if (op === 'in' && v.list.length) out.push({ field: f.field, op, value: v.list });
    else if (op === 'range' && (v.min !== '' || v.max !== '')) {
      out.push({
        field: f.field,
        op,
        value: { ...(v.min !== '' ? { min: Number(v.min) } : {}), ...(v.max !== '' ? { max: Number(v.max) } : {}) },
      });
    } else if (op === 'bool' && v.bool !== null) out.push({ field: f.field, op, value: v.bool });
    else if ((op === 'eq' || op === 'prefix') && v.text !== '') {
      out.push({ field: f.field, op, value: f.widget === 'number' ? Number(v.text) : v.text });
    }
  }
  const d = draft.value!;
  if (d.anyParams) out.push({ field: '', op: 'any' });
  for (const field of d.extraAny) {
    const pointer = field.startsWith('/') ? field : `/${field}`;
    if (!out.some((c) => c.field === pointer)) out.push({ field: pointer, op: 'any' });
  }
  return out;
}

async function save() {
  const d = draft.value;
  if (!d) return;
  const body = {
    operationId: d.operationId,
    match: buildMatch(),
    rateLimit: d.rateLimit ? Number(d.rateLimit) : null,
    windowSeconds: d.rateLimit && d.windowMinutes ? Number(d.windowMinutes) * 60 : null,
    expiresAt: d.expiresAt ? new Date(d.expiresAt).toISOString() : null,
    reason: d.reason,
    enabled: d.enabled,
  };
  try {
    if (d.id) await http.patch(`${base.value}/rules/${d.id}`, body);
    else await http.post(`${base.value}/rules`, body);
    draft.value = undefined;
    await load();
  } catch (err) {
    draft.value = { ...d, note: errorText(err) };
  }
}

async function toggle(rule: Rule) {
  try {
    await http.patch(`${base.value}/rules/${rule.id}`, { enabled: !rule.enabled });
    await load();
  } catch (err) {
    error.value = errorText(err);
  }
}
async function remove(rule: Rule) {
  if (!window.confirm(`Delete the rule for ${rule.operation.key}?`)) return;
  try {
    await http.del(`${base.value}/rules/${rule.id}`);
    await load();
  } catch (err) {
    error.value = errorText(err);
  }
}

function describe(c: MatchCondition, rule: Rule): string {
  const profile = rule.operation.matchProfile ? (profiles.value[rule.operation.matchProfile] ?? []) : [];
  const label = (field: string) => profile.find((f) => f.field === field)?.label ?? field;
  if (c.field === '$targets') {
    const t = c as { ids?: string[]; scopes?: Record<string, string[]> };
    const scopeLabel = (key: string) => targets.value?.scopes.find((s) => s.key === key)?.label ?? key;
    return [
      ...Object.entries(t.scopes ?? {}).map(([key, values]) => `${scopeLabel(key)} ∈ {${values.join(', ')}}`),
      t.ids?.length ? `${targets.value?.label ?? 'target'} ∈ {${t.ids.join(', ')}}` : '',
    ]
      .filter(Boolean)
      .join(' and ');
  }
  const pc = c as { field: string; op: string; value: unknown };
  const v = pc.value;
  if (pc.op === 'any') return pc.field === '' ? 'any other parameters' : `${label(pc.field)}: any value`;
  switch (pc.op) {
    case 'prefix':
      return `${label(pc.field)} starts with "${String(v)}"`;
    case 'in':
      return `${label(pc.field)} ∈ {${(v as unknown[]).join(', ')}}`;
    case 'range': {
      const r = v as { min?: number; max?: number };
      return `${r.min ?? '−∞'} ≤ ${label(pc.field)} ≤ ${r.max ?? '∞'}`;
    }
    default:
      return `${label(pc.field)} = ${JSON.stringify(v)}`;
  }
}
const reasonText = (r: string) => REASON_LABELS[r] ?? r;
const opSearch = ref('');
const pickable = computed(() => {
  const q = opSearch.value.trim().toLowerCase();
  return eligible.value.filter((o) => !q || o.key.toLowerCase().includes(q) || o.id === draft.value?.operationId);
});
watch(draft, (d) => {
  if (!d) opSearch.value = '';
});

/** Help shown beside each setting in the rule editor. */
const TIPS = {
  operation:
    "The write this rule pre-approves. Rules apply while the operation is at Ask; at Write it already runs without asking. Locked operations can't be pre-approved and always ask a person.",
  onlyWhen:
    'The rule applies only to calls whose parameters all match what you set here. An empty field means the call must not send that parameter.',
  anyValue: 'Accept this parameter with any value, or when it is left out.',
  extraAny:
    'Parameters this form does not list that a call may still send, with any value. Write them as paths, such as /quota.',
  anyParams:
    'Accept calls whatever other parameters they send. The rule then covers far more calls than the fields above suggest.',
  rateLimit:
    'How many calls this rule approves within the window. Calls over the limit are not refused; they ask a person instead. Leave empty for no limit.',
  window: 'The length of the rate-limit window, in minutes. Defaults to 60.',
  expires: 'After this time (your local time) the rule stops applying and calls ask again. Leave empty to keep it.',
  reason: 'Why this is safe to run without asking. Recorded in the audit log with every call the rule approves.',
  enabled: 'A disabled rule is kept but approves nothing, so matching calls ask a person.',
};
</script>

<template>
  <div class="stack">
    <div class="row">
      <p class="small muted grow">
        A matching call runs without asking a person. Rules never apply to locked operations, and a rule on an operation
        that is not reachable does nothing.
      </p>
      <button class="btn btn-primary" type="button" :disabled="!eligible.length" @click="edit()">New rule</button>
    </div>
    <p v-if="error" class="alert error" role="alert">{{ error }}</p>

    <div class="table-card">
      <table class="table">
        <thead>
          <tr>
            <th>Operation</th>
            <th>When</th>
            <th>Limits</th>
            <th>Reason</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rules" :key="r.id" :class="{ off: !r.enabled }">
            <td>
              <span class="mono">{{ r.operation.key }}</span>
              <span v-if="own && !r.editable" class="pill info">Admin</span>
              <span v-else-if="!own && r.owner" class="pill info">{{ r.owner.username }}</span>
              <div v-if="r.inert" class="pill warn">inert: {{ reasonText(r.inert) }}</div>
              <div v-if="r.strictMissAt" class="small warn-text">
                Skipped a call with parameters this rule doesn't accept ({{ ago(r.strictMissAt) }}). Edit it to accept
                them with “any value” if that's intended.
              </div>
            </td>
            <td class="small">
              <template v-if="r.match.length">
                <div v-for="(c, i) in r.match" :key="i">{{ describe(c, r) }}</div>
              </template>
              <span v-else class="muted">calls without parameters</span>
            </td>
            <td class="small">
              <div v-if="r.rateLimit">{{ r.rateLimit }} per {{ (r.windowSeconds ?? 3600) / 60 }} min</div>
              <div v-if="r.expiresAt">until {{ formatDate(r.expiresAt) }}</div>
              <span v-if="!r.rateLimit && !r.expiresAt" class="muted">none</span>
            </td>
            <td class="small">{{ r.reason }}</td>
            <td v-if="own && !r.editable" class="right small muted">Set by an admin</td>
            <td v-else class="right">
              <button class="btn btn-sm" type="button" @click="toggle(r)">
                {{ r.enabled ? 'Disable' : 'Enable' }}
              </button>
              <button class="btn btn-sm" type="button" @click="edit(r)">Edit</button>
              <button class="btn btn-sm btn-danger" type="button" @click="remove(r)">Delete</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!rules.length" class="empty">No pre-approval rules. Every write asks a person.</div>
    </div>

    <ModalDialog v-if="draft" :title="draft.id ? 'Edit rule' : 'New pre-approval rule'" wide @close="draft = undefined">
      <div class="field">
        <label for="r-op">Operation <InfoTip :text="TIPS.operation" label="About the operation" /></label>
        <input
          v-if="!draft.id"
          v-model="opSearch"
          class="op-search"
          placeholder="Filter operations…"
          aria-label="Filter operations"
        />
        <select id="r-op" v-model="draft.operationId" :disabled="!!draft.id" size="6">
          <option v-for="o in pickable" :key="o.id" :value="o.id">
            {{ o.key }}{{ o.reachable ? '' : ` — ${reasonText(o.reason ?? '')}` }}
          </option>
        </select>
        <p class="help">Only non-locked writes can be pre-approved.</p>
      </div>

      <template v-if="draftOp">
        <h2>Only when <InfoTip :text="TIPS.onlyWhen" label="About matching" /></h2>
        <p class="small muted">
          Strict: a call matches only if every parameter it sends is covered here. Leave a field empty to require that
          the parameter is absent, or tick “any value”.
        </p>
        <div v-for="f in fields" :key="f.field" class="field">
          <div class="field-head">
            <label
              >{{ f.label }} <span class="mono muted small">{{ f.field }}{{ f.op ? ` · ${f.op}` : '' }}</span></label
            >
            <label v-if="f.field !== '$targets'" class="row small any"
              ><input v-model="valueOf(f).any" type="checkbox" /> any value
              <InfoTip :text="TIPS.anyValue" label="About any value" end
            /></label>
          </div>
          <RegistryPicker
            v-if="f.field === '$targets' && targets"
            v-model="valueOf(f).targets"
            :instance-id="instance.id"
            :targets="targets"
            :options="targetOptions(f)"
          />
          <template v-else-if="valueOf(f).any" />
          <ChipsInput
            v-else-if="f.op === 'in'"
            v-model="valueOf(f).list"
            :suggestions="f.optionsSource ? options[f.optionsSource] : undefined"
            placeholder="Add a value"
          />
          <div v-else-if="f.op === 'range'" class="row">
            <input v-model="valueOf(f).min" type="number" placeholder="min" aria-label="Minimum" class="grow" />
            <input v-model="valueOf(f).max" type="number" placeholder="max" aria-label="Maximum" class="grow" />
          </div>
          <select
            v-else-if="f.op === 'bool'"
            :value="valueOf(f).bool === null ? '' : String(valueOf(f).bool)"
            @change="
              valueOf(f).bool =
                ($event.target as HTMLSelectElement).value === ''
                  ? null
                  : ($event.target as HTMLSelectElement).value === 'true'
            "
          >
            <option value="">—</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
          <select v-else-if="f.optionsSource && options[f.optionsSource]?.length" v-model="valueOf(f).text">
            <option value="">—</option>
            <option v-for="o in options[f.optionsSource]" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <input
            v-else
            v-model="valueOf(f).text"
            :type="f.widget === 'number' ? 'number' : 'text'"
            :placeholder="f.op === 'prefix' ? 'vol/media/' : ''"
          />
        </div>
      </template>

      <div v-if="draftOp" class="field">
        <label
          >Other parameters accepted with any value <InfoTip :text="TIPS.extraAny" label="About other parameters"
        /></label>
        <ChipsInput v-model="draft.extraAny" placeholder="e.g. /quota" />
        <label class="row small"
          ><input v-model="draft.anyParams" type="checkbox" /> Accept any other parameters (not recommended)
          <InfoTip :text="TIPS.anyParams" label="About accepting any parameters"
        /></label>
      </div>

      <div class="form-grid">
        <div class="field">
          <label for="r-rate">Rate limit (calls) <InfoTip :text="TIPS.rateLimit" label="About the rate limit" /></label>
          <input id="r-rate" v-model="draft.rateLimit" type="number" min="1" placeholder="unlimited" />
        </div>
        <div class="field">
          <label for="r-win">Per (minutes) <InfoTip :text="TIPS.window" label="About the window" /></label>
          <input
            id="r-win"
            v-model="draft.windowMinutes"
            type="number"
            min="1"
            placeholder="60"
            :disabled="!draft.rateLimit"
          />
        </div>
        <div class="field">
          <label for="r-exp">Expires <InfoTip :text="TIPS.expires" label="About expiry" end /></label>
          <input id="r-exp" v-model="draft.expiresAt" type="datetime-local" />
        </div>
      </div>
      <div class="field">
        <label for="r-reason"
          >Reason (required, shown in the audit log) <InfoTip :text="TIPS.reason" label="About the reason"
        /></label>
        <input id="r-reason" v-model="draft.reason" placeholder="Nightly media snapshots" />
      </div>
      <div class="field check">
        <label
          ><input v-model="draft.enabled" type="checkbox" /> Enabled
          <InfoTip :text="TIPS.enabled" label="About enabled"
        /></label>
      </div>
      <p v-if="draft.note" class="alert error" role="alert">{{ draft.note }}</p>
      <template #footer>
        <button class="btn" type="button" @click="draft = undefined">Cancel</button>
        <button
          class="btn btn-primary"
          type="button"
          :disabled="!draft.operationId || draft.reason.trim().length < 3"
          @click="save"
        >
          Save rule
        </button>
      </template>
    </ModalDialog>
  </div>
</template>

<style scoped>
.warn-text {
  color: var(--warning-text);
  margin-top: 4px;
}
.field-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 6px;
}
.field-head label {
  margin-bottom: 0;
}
.any {
  align-items: center;
}
.off td {
  opacity: 0.55;
}
.right {
  text-align: right;
  white-space: nowrap;
}
.right > * + * {
  margin-left: 6px;
}
.op-search {
  margin-bottom: 6px;
}
select[size] {
  font-family: var(--font-mono);
}
h2 {
  margin-top: 14px;
}
</style>
