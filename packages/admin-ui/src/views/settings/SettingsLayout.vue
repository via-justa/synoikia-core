<script setup lang="ts">
import { useRoute } from 'vue-router';
import { computed } from 'vue';
import PageHeader from '../../components/PageHeader.vue';
import { useSessionStore } from '../../stores/session';

const route = useRoute();
const session = useSessionStore();
const tabs = computed(() =>
  session.isAdmin
    ? [
        { path: 'mcp', label: 'MCP access' },
        { path: 'security', label: 'Admin UI settings' },
        { path: 'users', label: 'Users' },
        { path: 'roles', label: 'Roles' },
        { path: 'notifications', label: 'Notifications' },
        { path: 'profile', label: 'My profile' },
      ]
    : [{ path: 'profile', label: 'My profile' }],
);
</script>

<template>
  <div class="page">
    <PageHeader title="Settings" />
    <nav class="tabs" aria-label="Settings sections">
      <RouterLink
        v-for="t in tabs"
        :key="t.path"
        :to="`/settings/${t.path}`"
        :class="{ active: route.path === `/settings/${t.path}` }"
      >
        {{ t.label }}
      </RouterLink>
    </nav>
    <RouterView />
  </div>
</template>
