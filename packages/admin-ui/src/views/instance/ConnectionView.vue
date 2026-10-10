<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { errorText } from '../../api';
import ConnectClient from '../../components/ConnectClient.vue';
import MarkdownLite from '../../components/MarkdownLite';
import SchemaForm from '../../components/SchemaForm.vue';
import {
  useConnectionQuery,
  useSaveConnection,
  useSyncInstance,
  useTestConnection,
} from '../../composables/useInstance';
import { useSettingsQuery } from '../../composables/useSettings';
import { ago } from '../../format';
import type { Instance } from '../../types';

const props = defineProps<{ instance: Instance }>();
const id = () => props.instance.id;
const connQuery = useConnectionQuery(id);
const saveConnection = useSaveConnection(id);
const testConnection = useTestConnection(id);
const syncInstance = useSyncInstance(id);
const conn = computed(() => connQuery.data.value);
const config = ref<Record<string, unknown>>({});
const secretPatch = ref<Record<string, string | null>>({});
const result = ref<{ kind: 'ok' | 'error' | 'warn'; text: string }>();
const message = computed(
  () =>
    result.value ??
    (!conn.value && connQuery.error.value
      ? { kind: 'error' as const, text: errorText(connQuery.error.value) }
      : undefined),
);
const busy = computed(() =>
  saveConnection.isPending.value
    ? 'save'
    : testConnection.isPending.value
      ? 'test'
      : syncInstance.isPending.value
        ? 'sync'
        : undefined,
);

// The form is a draft: it takes the stored values once, and again only after a save.
function resetDraft() {
  if (!conn.value) return;
  config.value = { ...conn.value.config };
  secretPatch.value = {};
}
watch(conn, (c, old) => !old && c && resetDraft(), { immediate: true });

// For the "Connect a client" card: whether clients may self-register (a Cloudflare portal needs it).
const settingsQuery = useSettingsQuery();
const dynamicRegistration = computed(() => settingsQuery.data.value?.mcp.allowDynamicRegistration ?? null);

const body = () => ({
  config: config.value,
  // An empty "replace" box means the admin changed their mind: keep the stored value.
  secrets: Object.fromEntries(Object.entries(secretPatch.value).filter(([, v]) => v !== '')),
});

const failed = (err: unknown) => (result.value = { kind: 'error', text: errorText(err) });

function save() {
  result.value = undefined;
  saveConnection.mutate(body(), {
    onSuccess: () => {
      resetDraft();
      result.value = { kind: 'ok', text: 'Saved. The endpoint restarted with the new connection.' };
    },
    onError: failed,
  });
}

function test() {
  result.value = undefined;
  testConnection.mutate(body(), {
    onSuccess: (res) =>
      (result.value = res.ok
        ? {
            kind: 'ok',
            text: `Connection works${res.version ? ` (upstream ${res.version})` : ''}.${res.message ? ` ${res.message}` : ''}`,
          }
        : { kind: 'error', text: `Connection failed: ${res.message ?? 'unknown error'}` }),
    onError: failed,
  });
}

function sync() {
  result.value = undefined;
  syncInstance.mutate(undefined, {
    onSuccess: (res) =>
      (result.value = {
        kind: res.pendingReview.length ? 'warn' : 'ok',
        text:
          `Synced: ${res.added} new, ${res.updated} updated, ${res.staled} removed.` +
          (res.pendingReview.length
            ? ` ${res.pendingReview.length} new write(s) wait for review on the Access page.`
            : ''),
      }),
    onError: failed,
  });
}
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
