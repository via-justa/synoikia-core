<script setup lang="ts">
import { computed, ref } from 'vue';
import { errorText } from '../../api';
import ModalDialog from '../../components/ModalDialog.vue';
import { useConfirm } from '../../composables/useConfirm';
import { useDeleteNotifier, useNotifiersQuery, useSaveNotifier, useTestNotifier } from '../../composables/useNotifiers';
import { useInstances } from '../../composables/useOverview';
import { ago } from '../../format';
import { NOTIFY_EVENTS } from '../../types';
import type { Notifier, NotifyEvent } from '../../types';

const instances = useInstances();
const notifiersQuery = useNotifiersQuery();
const saveNotifier = useSaveNotifier();
const testNotifier = useTestNotifier();
const deleteNotifier = useDeleteNotifier();
const { confirm } = useConfirm();
const channels = computed(() => notifiersQuery.data.value ?? []);
const actionError = ref<string>();
const error = computed(() => {
  const loadError = notifiersQuery.error.value;
  return actionError.value ?? (loadError ? errorText(loadError) : undefined);
});
const notice = ref<string>();

const EVENT_LABELS: Record<NotifyEvent, string> = {
  'instance.error': 'Endpoint went down',
  'instance.recovered': 'Endpoint recovered',
  'plugin.crashed': 'Plugin crashed',
  'sync.failed': 'Catalog sync failed',
  'sync.pending_review': 'New write operations found (they ask until acknowledged)',
  'auth.lockout': 'Sign-in lockout',
};

interface Draft {
  id?: string;
  kind: 'ntfy' | 'webhook';
  name: string;
  server: string;
  topic: string;
  url: string;
  token: string;
  hmacSecret: string;
  clear: Record<string, boolean>;
  events: NotifyEvent[];
  allInstances: boolean;
  instanceFilter: string[];
  enabled: boolean;
  secretsSet: Record<string, boolean>;
  note?: string;
}
const draft = ref<Draft>();

function edit(ch?: Notifier) {
  draft.value = {
    id: ch?.id,
    kind: ch?.kind ?? 'ntfy',
    name: ch?.name ?? '',
    server: ch?.config.server ?? 'https://ntfy.sh',
    topic: ch?.config.topic ?? '',
    url: ch?.config.url ?? '',
    token: '',
    hmacSecret: '',
    clear: {},
    events: ch?.events ?? ['instance.error', 'sync.failed', 'sync.pending_review'],
    allInstances: !ch?.instanceFilter?.length,
    instanceFilter: ch?.instanceFilter ?? [],
    enabled: ch?.enabled ?? true,
    secretsSet: Object.fromEntries(Object.entries(ch?.secrets ?? {}).map(([k, v]) => [k, v.set])),
  };
}

function save() {
  const d = draft.value;
  if (!d) return;
  const secret = (key: 'token' | 'hmacSecret') => (d.clear[key] ? null : d[key] ? d[key] : undefined);
  const body = {
    ...(d.id ? {} : { kind: d.kind }),
    name: d.name.trim(),
    config: d.kind === 'ntfy' ? { server: d.server.trim(), topic: d.topic.trim() } : { url: d.url.trim() },
    secrets: d.kind === 'ntfy' ? { token: secret('token') } : { hmacSecret: secret('hmacSecret') },
    events: d.events,
    instanceFilter: d.allInstances ? null : d.instanceFilter,
    enabled: d.enabled,
  };
  saveNotifier.mutate(
    { id: d.id, body },
    {
      onSuccess: () => (draft.value = undefined),
      onError: (err) => (draft.value = { ...d, note: errorText(err) }),
    },
  );
}

function test(ch: Notifier) {
  notice.value = undefined;
  actionError.value = undefined;
  testNotifier.mutate(ch.id, {
    onSuccess: (res) => {
      if (res.ok) notice.value = `Test sent to ${ch.name}.`;
      else actionError.value = `Test to ${ch.name} failed: ${res.error}`;
    },
    onError: (err) => (actionError.value = errorText(err)),
  });
}
async function remove(ch: Notifier) {
  if (!(await confirm({ title: `Delete ${ch.name}?`, action: 'Delete', danger: true }))) return;
  deleteNotifier.mutate(ch.id, { onError: (err) => (actionError.value = errorText(err)) });
}
</script>

<template>
  <div class="stack">
    <div class="row">
      <p class="small muted grow">
        Notifications keep you informed; they carry summaries, never parameters or secrets. Approvals happen in your MCP
        client, which opens the approval page.
      </p>
      <button class="btn btn-primary" type="button" @click="edit()">Add channel</button>
    </div>
    <p v-if="error" class="alert error" role="alert">{{ error }}</p>
    <p v-if="notice" class="alert ok" role="status">{{ notice }}</p>

    <div class="table-card">
      <table class="table">
        <thead>
          <tr>
            <th>Channel</th>
            <th>Events</th>
            <th>Last sent</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="ch in channels" :key="ch.id" :class="{ off: !ch.enabled }">
            <td>
              <strong>{{ ch.name }}</strong> <span class="pill">{{ ch.kind }}</span>
              <div class="small mono muted">
                {{ ch.kind === 'ntfy' ? `${ch.config.server}/${ch.config.topic}` : ch.config.url }}
              </div>
              <div v-if="ch.lastError" class="small err">{{ ch.lastError }}</div>
            </td>
            <td class="small">
              {{ ch.events.length }} event(s){{
                ch.instanceFilter?.length ? ` · ${ch.instanceFilter.length} endpoint(s)` : ''
              }}
            </td>
            <td class="small">{{ ago(ch.lastSentAt) }}</td>
            <td class="right">
              <button class="btn btn-sm" type="button" @click="test(ch)">Test</button>
              <button class="btn btn-sm" type="button" @click="edit(ch)">Edit</button>
              <button class="btn btn-sm btn-danger" type="button" @click="remove(ch)">Delete</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!channels.length" class="empty">No notification channels.</div>
    </div>

    <ModalDialog
      v-if="draft"
      :title="draft.id ? `Edit ${draft.name}` : 'Add notification channel'"
      wide
      @close="draft = undefined"
    >
      <div class="form-grid">
        <div class="field">
          <label for="n-kind">Type</label>
          <select id="n-kind" v-model="draft.kind" :disabled="!!draft.id">
            <option value="ntfy">ntfy</option>
            <option value="webhook">Webhook</option>
          </select>
        </div>
        <div class="field">
          <label for="n-name">Name</label>
          <input id="n-name" v-model="draft.name" placeholder="Phone" />
        </div>
      </div>
      <div v-if="draft.kind === 'ntfy'" class="form-grid">
        <div class="field">
          <label for="n-srv">Server</label>
          <input id="n-srv" v-model="draft.server" />
        </div>
        <div class="field">
          <label for="n-topic">Topic</label>
          <input id="n-topic" v-model="draft.topic" placeholder="homelab-a8f3" />
          <p class="help">On public servers, anyone who knows the topic can read it: pick something unguessable.</p>
        </div>
        <div class="field">
          <label for="n-tok">Access token</label>
          <input
            id="n-tok"
            v-model="draft.token"
            type="password"
            autocomplete="new-password"
            :placeholder="draft.secretsSet.token ? 'Set — leave empty to keep' : 'Optional'"
          />
          <label v-if="draft.secretsSet.token" class="row small"
            ><input v-model="draft.clear.token" type="checkbox" /> Remove token</label
          >
        </div>
      </div>
      <div v-else class="form-grid">
        <div class="field">
          <label for="n-url">URL</label>
          <input id="n-url" v-model="draft.url" placeholder="https://hooks.example.com/mcp" />
        </div>
        <div class="field">
          <label for="n-hmac">Signing secret</label>
          <input
            id="n-hmac"
            v-model="draft.hmacSecret"
            type="password"
            autocomplete="new-password"
            :placeholder="draft.secretsSet.hmacSecret ? 'Set — leave empty to keep' : 'Optional'"
          />
          <p class="help">
            Sent as <span class="mono">x-synoikia-signature: sha256=HMAC(secret, timestamp + "." + body)</span>.
          </p>
          <label v-if="draft.secretsSet.hmacSecret" class="row small"
            ><input v-model="draft.clear.hmacSecret" type="checkbox" /> Remove secret</label
          >
        </div>
      </div>
      <div class="field">
        <label>Events</label>
        <label v-for="e in NOTIFY_EVENTS" :key="e" class="row small">
          <input v-model="draft.events" type="checkbox" :value="e" /> {{ EVENT_LABELS[e] }}
        </label>
      </div>
      <div class="field">
        <label>Endpoints</label>
        <label class="row small"><input v-model="draft.allInstances" type="checkbox" /> All endpoints</label>
        <template v-if="!draft.allInstances">
          <label v-for="i in instances" :key="i.id" class="row small">
            <input v-model="draft.instanceFilter" type="checkbox" :value="i.id" />
            <span class="mono">/{{ i.slug }}</span>
          </label>
        </template>
      </div>
      <div class="field check">
        <label><input v-model="draft.enabled" type="checkbox" /> Enabled</label>
      </div>
      <p v-if="draft.note" class="alert error" role="alert">{{ draft.note }}</p>
      <template #footer>
        <button class="btn" type="button" @click="draft = undefined">Cancel</button>
        <button
          class="btn btn-primary"
          type="button"
          :disabled="!draft.name.trim() || !draft.events.length"
          @click="save"
        >
          Save
        </button>
      </template>
    </ModalDialog>
  </div>
</template>

<style scoped>
.off td {
  opacity: 0.55;
}
.err {
  color: var(--danger-text);
}
.right {
  text-align: right;
  white-space: nowrap;
}
.right > * + * {
  margin-left: 6px;
}
</style>
