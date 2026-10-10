<script setup lang="ts">
import { computed, useId } from 'vue';
import { errorText } from '../api';
import PageHeader from '../components/PageHeader.vue';
import { useCopy } from '../composables/useCopy';
import { useOverviewQuery } from '../composables/useOverview';
import { AUTH_MODE_LABELS, ago } from '../format';

const { data: overview, error: loadError, isPending: loading } = useOverviewQuery();
const instances = computed(() => overview.value?.instances ?? []);
const error = computed(() => (loadError.value ? errorText(loadError.value) : undefined));

const unhealthyPlugins = computed(() => (overview.value?.plugins ?? []).filter((p) => p.status !== 'ok'));
const { copied, copy } = useCopy();
const uid = useId();
</script>

<template>
  <div class="page">
    <PageHeader title="Overview" subtitle="Endpoints, their health and anything waiting on you">
      <RouterLink class="btn btn-primary" to="/endpoints/new">New endpoint</RouterLink>
    </PageHeader>

    <div class="stack">
      <p v-if="error" class="alert error" role="alert">{{ error }}</p>
      <div v-for="w in overview?.warnings ?? []" :key="w" class="alert warn">{{ w }}</div>
      <div v-if="unhealthyPlugins.length" class="alert warn">
        Plugin problems:
        <span v-for="p in unhealthyPlugins" :key="p.id" class="mono"> {{ p.pluginId }} ({{ p.status }}) </span>
        — see <RouterLink to="/plugins">Plugins</RouterLink>.
      </div>

      <div class="table-card">
        <table class="table" aria-label="Endpoints" :aria-busy="loading">
          <thead>
            <tr>
              <th>Endpoint</th>
              <th>Plugin</th>
              <th>Status</th>
              <th>Auth</th>
              <th>Last sync</th>
              <th><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="i in instances" :key="i.id">
              <td>
                <RouterLink :id="`${uid}-${i.id}`" :to="`/endpoints/${i.slug}/connection`" class="mono"
                  >/{{ i.slug }}</RouterLink
                >
                <div class="small muted">{{ i.displayName }}</div>
              </td>
              <td>{{ i.plugin.name }}</td>
              <td>
                <span class="row">
                  <span class="dot" :class="i.status" aria-hidden="true" />
                  {{ i.enabled ? i.status : 'disabled' }}
                </span>
                <div v-if="i.statusError" class="small err">{{ i.statusError }}</div>
              </td>
              <td>{{ AUTH_MODE_LABELS[i.effectiveAuthMode ?? ''] ?? i.effectiveAuthMode }}</td>
              <td>
                {{ ago(i.lastSyncedAt) }}
                <span v-if="i.lastSyncStatus === 'error'" class="pill danger">failed</span>
              </td>
              <td class="right">
                <button
                  v-if="i.endpointUrl"
                  class="btn btn-sm"
                  type="button"
                  :aria-describedby="`${uid}-${i.id}`"
                  @click="copy(i.endpointUrl)"
                >
                  {{ copied === i.endpointUrl ? 'Copied' : 'Copy URL' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="loading" class="sr-only" role="status">Loading…</p>
        <div v-if="overview && !instances.length" class="empty">
          No endpoints yet. <RouterLink to="/endpoints/new">Create one</RouterLink> from an enabled plugin.
        </div>
      </div>
      <p v-if="overview && !overview.publicMcpUrl" class="small muted">
        Set <code>PUBLIC_MCP_URL</code> so endpoint URLs point at your public MCP address.
      </p>
    </div>
  </div>
</template>

<style scoped>
.err {
  color: var(--danger-text);
}
.right {
  text-align: right;
  white-space: nowrap;
}
.right > * + * {
  margin-left: 8px;
}
</style>
