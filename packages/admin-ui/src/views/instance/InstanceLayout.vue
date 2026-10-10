<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useInstances, useRefreshOverview } from '../../composables/useOverview';

/** Resolves `/endpoints/:slug/*` to an instance and hands it to the tab views. */
const instances = useInstances();
const refreshOverview = useRefreshOverview();
const route = useRoute();
const slug = computed(() => String(route.params.slug));
const instance = computed(() => instances.value.find((i) => i.slug === slug.value));
const loaded = ref(false);

async function ensure() {
  if (!instance.value) await refreshOverview().catch(() => undefined);
  loaded.value = true;
}
onMounted(ensure);
watch(slug, ensure);

const tabs = [
  { path: 'connection', label: 'Connection' },
  { path: 'access', label: 'Access' },
  { path: 'rules', label: 'Pre-Approval Rules' },
  { path: 'settings', label: 'Settings' },
];
</script>

<template>
  <div class="page">
    <template v-if="instance">
      <div class="page-header">
        <div>
          <h1>
            <span class="mono">/{{ instance.slug }}</span>
            <span class="dot" :class="instance.status" :title="instance.status" />
          </h1>
          <p class="sub">
            {{ instance.displayName
            }}<template v-if="instance.plugin.name !== instance.displayName"> · {{ instance.plugin.name }}</template>
            <template v-if="instance.upstreamVersion"> · upstream {{ instance.upstreamVersion }}</template>
            <template v-if="!instance.enabled"> · <strong>disabled</strong></template>
          </p>
        </div>
      </div>
      <p v-if="instance.statusError" class="alert error">{{ instance.statusError }}</p>
      <nav class="tabs">
        <RouterLink
          v-for="t in tabs"
          :key="t.path"
          :to="`/endpoints/${instance.slug}/${t.path}`"
          :class="{ active: route.path.endsWith(`/${t.path}`) }"
        >
          {{ t.label }}
        </RouterLink>
      </nav>
      <RouterView :key="instance.id" :instance="instance" />
    </template>
    <div v-else-if="loaded" class="card empty">
      No endpoint at <span class="mono">/{{ slug }}</span
      >. <RouterLink to="/">Back to overview</RouterLink>
    </div>
  </div>
</template>

<style scoped>
h1 {
  display: flex;
  gap: 10px;
  align-items: center;
}
</style>
