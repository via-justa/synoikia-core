<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { errorText, http } from '../api';
import LevelTable from '../components/LevelTable.vue';
import { ago } from '../format';
import { useAppStore } from '../stores/app';
import { useSessionStore } from '../stores/session';
import type { Level, LevelView } from '../types';
import RulesView from './instance/RulesView.vue';

/** One endpoint as a user sees it (design §6.4): their operations and levels, read-only unless the role
 * lets them set their own, and their own pre-approval rules where the role allows them. */
const route = useRoute();
const app = useAppStore();
const session = useSessionStore();
const id = computed(() => String(route.params.id));
const endpoint = computed(() => app.mine.find((e) => e.id === id.value));
const base = computed(() => `/api/me/endpoints/${id.value}`);
const view = ref<LevelView>();
const tab = ref<'access' | 'rules'>('access');
const error = ref<string>();

async function load() {
  error.value = undefined;
  try {
    if (!app.mine.length) await app.refreshMine();
    view.value = await http.get<LevelView>(`${base.value}/access`);
  } catch (err) {
    error.value = errorText(err);
  }
}
onMounted(load);
watch(id, load);

async function apply(path: string, level: Level | null) {
  error.value = undefined;
  try {
    view.value = await http.put<LevelView>(`${base.value}/${path}`, { level });
  } catch (err) {
    error.value = errorText(err);
  }
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1>
          <span class="mono">/{{ endpoint?.slug ?? '…' }}</span>
          <span v-if="endpoint?.status" class="dot" :class="endpoint.status.state" :title="endpoint.status.state" />
        </h1>
        <p class="sub">
          {{ endpoint?.displayName }}
          <template v-if="endpoint?.status">
            · {{ endpoint.status.plugin }}
            <template v-if="endpoint.status.upstreamVersion">
              · upstream {{ endpoint.status.upstreamVersion }}</template
            >
            · synced {{ ago(endpoint.status.lastSyncedAt) }}
            <template v-if="!endpoint.status.enabled"> · <strong>disabled</strong></template>
          </template>
        </p>
      </div>
    </div>
    <p v-if="endpoint?.status?.error" class="alert error">{{ endpoint.status.error }}</p>
    <nav v-if="session.role?.canManageOwnRules" class="tabs">
      <a href="#" :class="{ active: tab === 'access' }" @click.prevent="tab = 'access'">Access</a>
      <a href="#" :class="{ active: tab === 'rules' }" @click.prevent="tab = 'rules'">My pre-approval rules</a>
    </nav>
    <p v-if="error" class="alert error" role="alert">{{ error }}</p>
    <div v-if="tab === 'access'" class="stack">
      <p class="small muted">
        <template v-if="session.role?.canSetOwnLevels">
          Your role sets the most each operation can do here. You can lower that for your own clients.
        </template>
        <template v-else>The levels your role gives you. An administrator sets them.</template>
      </p>
      <LevelTable
        v-if="view"
        :view="view"
        layer="own"
        :editable="!!session.role?.canSetOwnLevels"
        @set-group="(key, level) => apply(`groups/${encodeURIComponent(key)}`, level)"
        @set-op="(opId, level) => apply(`operations/${opId}`, level)"
      />
    </div>
    <RulesView v-else :key="id" :instance="{ id }" own />
  </div>
</template>
