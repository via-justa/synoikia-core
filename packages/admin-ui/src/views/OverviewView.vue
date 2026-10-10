<script setup lang="ts">
import { computed, ref } from 'vue';
import { errorText } from '../api';
import PageHeader from '../components/PageHeader.vue';
import { useOverviewQuery } from '../composables/useOverview';
import { AUTH_MODE_LABELS, ago } from '../format';

const { data: overview, error: loadError } = useOverviewQuery();
const instances = computed(() => overview.value?.instances ?? []);
const error = computed(() => (loadError.value ? errorText(loadError.value) : undefined));

const unhealthyPlugins = computed(() => (overview.value?.plugins ?? []).filter((p) => p.status !== 'ok'));
const copied = ref<string>();
async function copy(url: string) {
  await navigator.clipboard?.writeText(url).catch(() => undefined);
  copied.value = url;
  setTimeout(() => (copied.value = undefined), 1500);
}
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
        <table class="table">
          <thead>
            <tr>
              <th>Endpoint</th>
              <th>Plugin</th>
              <th>Status</th>
              <th>Auth</th>
              <th>Last sync</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="i in instances" :key="i.id">
              <td>
                <RouterLink :to="`/endpoints/${i.slug}/connection`" class="mono">/{{ i.slug }}</RouterLink>
                <div class="small muted">{{ i.displayName }}</div>
              </td>
              <td>{{ i.plugin.name }}</td>
              <td>
                <span class="row">
                  <span class="dot" :class="i.status" />
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
                <button v-if="i.endpointUrl" class="btn btn-sm" type="button" @click="copy(i.endpointUrl)">
                  {{ copied === i.endpointUrl ? 'Copied' : 'Copy URL' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
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
