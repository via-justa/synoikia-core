<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { errorText, http } from '../../api';
import ConnectClient from '../../components/ConnectClient.vue';
import MarkdownLite from '../../components/MarkdownLite';
import SchemaForm from '../../components/SchemaForm.vue';
import { useRefreshOverview } from '../../composables/useOverview';
import { ago } from '../../format';
import type { Connection, Instance, Settings } from '../../types';

const props = defineProps<{ instance: Instance }>();
const refreshOverview = useRefreshOverview();
const conn = ref<Connection>();
const config = ref<Record<string, unknown>>({});
const secretPatch = ref<Record<string, string | null>>({});
const message = ref<{ kind: 'ok' | 'error' | 'warn'; text: string }>();
const busy = ref<'save' | 'test' | 'sync'>();

async function load() {
  conn.value = await http.get<Connection>(`/api/instances/${props.instance.id}/connection`);
  config.value = { ...conn.value.config };
  secretPatch.value = {};
}
onMounted(() => load().catch((err) => (message.value = { kind: 'error', text: errorText(err) })));

// For the "Connect a client" card: whether clients may self-register (a Cloudflare portal needs it).
const dynamicRegistration = ref<boolean | null>(null);
onMounted(() =>
  http
    .get<Settings>('/api/settings')
    .then((s) => (dynamicRegistration.value = s.mcp.allowDynamicRegistration))
    .catch(() => undefined),
);

const body = () => ({
  config: config.value,
  // An empty "replace" box means the admin changed their mind: keep the stored value.
  secrets: Object.fromEntries(Object.entries(secretPatch.value).filter(([, v]) => v !== '')),
});

async function run(kind: 'save' | 'test' | 'sync', fn: () => Promise<void>) {
  busy.value = kind;
  message.value = undefined;
  try {
    await fn();
  } catch (err) {
    message.value = { kind: 'error', text: errorText(err) };
  } finally {
    busy.value = undefined;
  }
}

const save = () =>
  run('save', async () => {
    await http.put(`/api/instances/${props.instance.id}/connection`, body());
    await load();
    await refreshOverview();
    message.value = { kind: 'ok', text: 'Saved. The endpoint restarted with the new connection.' };
  });

const test = () =>
  run('test', async () => {
    const res = await http.post<{ ok: boolean; message?: string; version?: string }>(
      `/api/instances/${props.instance.id}/connection/test`,
      body(),
    );
    message.value = res.ok
      ? {
          kind: 'ok',
          text: `Connection works${res.version ? ` (upstream ${res.version})` : ''}.${res.message ? ` ${res.message}` : ''}`,
        }
      : { kind: 'error', text: `Connection failed: ${res.message ?? 'unknown error'}` };
  });

const sync = () =>
  run('sync', async () => {
    const res = await http.post<{ added: number; updated: number; staled: number; pendingReview: string[] }>(
      `/api/instances/${props.instance.id}/sync`,
    );
    await refreshOverview();
    message.value = {
      kind: res.pendingReview.length ? 'warn' : 'ok',
      text:
        `Synced: ${res.added} new, ${res.updated} updated, ${res.staled} removed.` +
        (res.pendingReview.length
          ? ` ${res.pendingReview.length} new write(s) wait for review on the Access page.`
          : ''),
    };
  });
</script>

<template>
  <div class="grid">
    <form class="card" @submit.prevent="save">
      <template v-if="conn">
        <SchemaForm
          v-model:config="config"
          v-model:secret-patch="secretPatch"
          :schema="conn.schema"
          :ui="conn.ui"
          :secrets="conn.secrets"
        />
        <p v-if="message" class="alert" :class="message.kind" role="status">{{ message.text }}</p>
        <div class="actions">
          <button class="btn btn-primary" type="submit" :disabled="!!busy">
            {{ busy === 'save' ? 'Saving…' : 'Save' }}
          </button>
          <button class="btn" type="button" :disabled="!!busy" @click="test">
            {{ busy === 'test' ? 'Testing…' : 'Test connection' }}
          </button>
        </div>
      </template>
      <p v-else-if="message" class="alert error">{{ message.text }}</p>
    </form>

    <aside class="stack">
      <div class="card">
        <h2>Catalog</h2>
        <p class="small">
          Last sync {{ ago(instance.lastSyncedAt) }}
          <span v-if="instance.lastSyncStatus === 'error'" class="pill danger">failed</span>
        </p>
        <p v-if="instance.sourceRef" class="small">
          Source <code>{{ instance.sourceRef }}</code>
        </p>
        <p class="small muted">
          The operation catalog is re-read from the upstream on session start when stale, daily, and when the upstream
          version changes.
        </p>
        <button class="btn" type="button" :disabled="!!busy || instance.status !== 'ready'" @click="sync">
          {{ busy === 'sync' ? 'Syncing…' : 'Sync now' }}
        </button>
      </div>
      <div v-if="conn?.help" class="card">
        <h2>Setup notes</h2>
        <MarkdownLite class="small help-text" :source="conn.help" />
      </div>
      <ConnectClient :instance="instance" :dynamic-registration="dynamicRegistration" />
    </aside>
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(220px, 1fr);
  gap: 16px;
  align-items: start;
}
.help-text :deep(p),
.help-text :deep(ol),
.help-text :deep(ul) {
  margin: 0 0 8px;
}
.help-text :deep(ol),
.help-text :deep(ul) {
  padding-left: 18px;
}
.help-text :deep(li) {
  margin-bottom: 4px;
}
@media (max-width: 860px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
