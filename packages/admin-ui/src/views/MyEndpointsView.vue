<script setup lang="ts">
import { computed, ref } from 'vue';
import { errorText } from '../api';
import PageHeader from '../components/PageHeader.vue';
import { useMyEndpointsQuery } from '../composables/useMyEndpoints';
import { AUTH_MODE_LABELS, ago } from '../format';
import { useSessionStore } from '../stores/session';

/** Every user's home (design §6.4): the endpoints their role has, and how to connect to them. */
const session = useSessionStore();
const { endpoints: mine, error: loadError } = useMyEndpointsQuery();
const error = computed(() => (loadError.value ? errorText(loadError.value) : undefined));

const copied = ref<string>();
async function copy(url: string) {
  await navigator.clipboard?.writeText(url).catch(() => undefined);
  copied.value = url;
  setTimeout(() => (copied.value = undefined), 1500);
}
</script>

<template>
  <div class="page">
    <PageHeader
      title="My endpoints"
      :subtitle="`What your role (${session.role?.name ?? '—'}) lets you reach. Create a token under My profile to connect a client.`"
    />
    <div class="stack">
      <p v-if="error" class="alert error" role="alert">{{ error }}</p>
      <div class="table-card">
        <table class="table">
          <thead>
            <tr>
              <th>Endpoint</th>
              <th>URL</th>
              <th>Sign-in</th>
              <th v-if="mine.some((e) => e.status)">Status</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="ep in mine" :key="ep.id">
              <td>
                <RouterLink :to="`/my/${ep.id}`" class="mono">/{{ ep.slug }}</RouterLink>
                <div class="small muted">{{ ep.displayName }}</div>
              </td>
              <td>
                <span class="mono small">{{ ep.endpointUrl }}</span>
                <button class="btn btn-sm" type="button" @click="copy(ep.endpointUrl)">
                  {{ copied === ep.endpointUrl ? 'Copied' : 'Copy' }}
                </button>
              </td>
              <td class="small">{{ AUTH_MODE_LABELS[ep.authMode] ?? ep.authMode }}</td>
              <td v-if="ep.status" class="small">
                <span class="dot" :class="ep.status.state" /> {{ ep.status.state }}
                <template v-if="!ep.status.enabled"> · disabled</template>
                <div class="muted">synced {{ ago(ep.status.lastSyncedAt) }}</div>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="!mine.length" class="empty">Your role has no endpoints yet. Ask an administrator.</div>
      </div>
    </div>
  </div>
</template>
