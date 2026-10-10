<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { useRoute } from 'vue-router';
import { rovingKeydown } from '../a11y';
import { errorText } from '../api';
import { useMyEndpointsQuery } from '../composables/useMyEndpoints';
import { ago } from '../format';
import { useSessionStore } from '../stores/session';
import AccessView from './instance/AccessView.vue';
import RulesView from './instance/RulesView.vue';

/** One endpoint as a user sees it (design §6.4): their operations and levels, read-only unless the role
 * lets them set their own, and their own pre-approval rules where the role allows them. */
const route = useRoute();
const session = useSessionStore();
const id = computed(() => String(route.params.id));
const { endpoints: mine, error: loadError } = useMyEndpointsQuery();
const endpoint = computed(() => mine.value.find((e) => e.id === id.value));
const tab = ref<'access' | 'rules'>('access');
const uid = useId();
const tabs = computed(() => !!session.role?.canManageOwnRules);
const TABS = [
  ['access', 'Access'],
  ['rules', 'My pre-approval rules'],
] as const;
const error = computed(() => (loadError.value ? errorText(loadError.value) : undefined));
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1>
          <span class="mono">/{{ endpoint?.slug ?? '…' }}</span>
          <span
            v-if="endpoint?.status"
            class="dot"
            :class="endpoint.status.state"
            :title="endpoint.status.state"
            role="img"
            :aria-label="endpoint.status.state"
          />
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
    <p v-if="endpoint?.status?.error" class="alert error" role="alert">{{ endpoint.status.error }}</p>
    <nav v-if="tabs" class="tabs" role="tablist" aria-label="Endpoint sections" @keydown="rovingKeydown">
      <a
        v-for="[key, label] in TABS"
        :id="`${uid}-tab-${key}`"
        :key="key"
        href="#"
        role="tab"
        :aria-selected="tab === key"
        :aria-controls="tab === key ? `${uid}-panel` : undefined"
        :tabindex="tab === key ? 0 : -1"
        :class="{ active: tab === key }"
        @click.prevent="tab = key"
        >{{ label }}</a
      >
    </nav>
    <p v-if="error" class="alert error" role="alert">{{ error }}</p>
    <div
      v-if="tab === 'access'"
      :id="`${uid}-panel`"
      class="stack"
      :role="tabs ? 'tabpanel' : undefined"
      :aria-labelledby="tabs ? `${uid}-tab-access` : undefined"
    >
      <p class="small muted">
        <template v-if="session.role?.canSetOwnLevels">
          Your role sets the most each operation can do here. You can lower that for your own clients.
        </template>
        <template v-else>The levels your role gives you. An administrator sets them.</template>
      </p>
      <AccessView
        :key="id"
        :instance="{ id, slug: endpoint?.slug ?? '' }"
        :scope="{ kind: 'own' }"
        :readonly="!session.role?.canSetOwnLevels"
      />
    </div>
    <RulesView
      v-else
      :id="`${uid}-panel`"
      :key="id"
      role="tabpanel"
      :aria-labelledby="`${uid}-tab-rules`"
      :instance="{ id }"
      own
    />
  </div>
</template>

<style scoped>
h1 {
  display: flex;
  gap: 10px;
  align-items: center;
}
</style>
