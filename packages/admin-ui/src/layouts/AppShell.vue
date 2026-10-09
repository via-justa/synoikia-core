<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BrandLockup from '../components/BrandLockup.vue';
import { useAppStore } from '../stores/app';
import { useSessionStore } from '../stores/session';

const session = useSessionStore();
const app = useAppStore();
const router = useRouter();
const route = useRoute();

// Small screens: the sidebar collapses into a top bar with a menu toggle.
const menuOpen = ref(false);
watch(
  () => route.fullPath,
  () => (menuOpen.value = false),
);

const endpoints = computed(() => app.instances);
const ISSUES_URL = 'https://github.com/via-justa/synoikia-core/issues';

const globalNav = [
  { to: '/', label: 'Overview' },
  { to: '/audit', label: 'Audit Log' },
];
const adminNav = [
  { to: '/plugins', label: 'Plugins' },
  { to: '/clients', label: 'Clients & Tokens' },
  { to: '/settings', label: 'Settings' },
];

onMounted(() => {
  // Overview and live events are admin-only; every role has its own endpoint list (design §6.4).
  if (session.isAdmin) {
    void app.refresh().catch(() => undefined);
    app.connect();
  } else void app.refreshMine().catch(() => undefined);
});
onBeforeUnmount(() => app.disconnect());

async function logout() {
  app.disconnect();
  await session.logout();
  await router.replace('/login');
}
</script>

<template>
  <div class="shell">
    <aside class="sidebar" :class="{ open: menuOpen }">
      <div class="brand">
        <RouterLink :to="session.isAdmin ? '/' : '/my'" class="home" aria-label="Synoikia, home"
          ><BrandLockup :size="32"
        /></RouterLink>
        <button class="menu mobile-only" type="button" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen">
          {{ menuOpen ? 'Close' : 'Menu' }}
        </button>
      </div>

      <nav v-if="!session.isAdmin">
        <RouterLink to="/my" class="nav-item" exact-active-class="active"><span>My endpoints</span></RouterLink>
        <div class="nav-section">Endpoints</div>
        <RouterLink
          v-for="ep in app.mine"
          :key="ep.id"
          :to="`/my/${ep.id}`"
          class="nav-item mono"
          :class="{ active: $route.path === `/my/${ep.id}` }"
        >
          <span>/{{ ep.slug }}</span>
          <span v-if="ep.status" class="dot" :class="ep.status.state" :title="ep.status.state" />
        </RouterLink>
        <div v-if="app.mine.length === 0" class="nav-empty">No endpoints for your role</div>
        <div class="nav-section" />
        <RouterLink to="/settings/profile" class="nav-item" active-class="active">My profile</RouterLink>
      </nav>
      <nav v-else>
        <RouterLink v-for="item in globalNav" :key="item.to" :to="item.to" class="nav-item" exact-active-class="active">
          <span>{{ item.label }}</span>
        </RouterLink>

        <div class="nav-section">Endpoints</div>
        <RouterLink
          v-for="ep in endpoints"
          :key="ep.slug"
          :to="`/endpoints/${ep.slug}/connection`"
          class="nav-item mono"
          :class="{ active: $route.path.startsWith(`/endpoints/${ep.slug}/`) }"
        >
          <span>/{{ ep.slug }}</span>
          <span class="dot" :class="ep.status" :title="ep.status" />
        </RouterLink>
        <div v-if="endpoints.length === 0" class="nav-empty">No endpoints yet</div>
        <RouterLink to="/endpoints/new" class="nav-item add" exact-active-class="active">+ New endpoint</RouterLink>

        <div class="nav-section" />
        <RouterLink v-for="item in adminNav" :key="item.to" :to="item.to" class="nav-item" active-class="active">
          {{ item.label }}
        </RouterLink>
      </nav>

      <div class="about">
        <span v-if="app.overview?.version" class="mono">v{{ app.overview.version }}</span>
        <a
          :href="ISSUES_URL"
          class="github"
          target="_blank"
          rel="noopener noreferrer"
          title="Report a bug or request a feature on GitHub"
          aria-label="Report a bug or request a feature on GitHub"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
            />
          </svg>
        </a>
      </div>
      <div class="footer">
        <RouterLink to="/settings/profile" class="me">{{ session.username ?? 'admin' }}</RouterLink>
        <button class="link" type="button" @click="logout">Log out</button>
      </div>
    </aside>

    <main class="content">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  min-height: 100vh;
}
.sidebar {
  width: 232px;
  flex-shrink: 0;
  background: var(--surface-200);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  padding: 20px 0;
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
}
.brand {
  padding: 0 20px 20px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.home {
  text-decoration: none;
  border-radius: var(--radius-md);
}
nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 10px;
}
.nav-item {
  padding: 8px 10px;
  border-radius: var(--radius-md);
  color: var(--ink-muted);
  font-size: 14px;
  line-height: 20px;
  font-weight: 500;
  text-decoration: none;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.nav-item:hover {
  background: var(--surface-300);
  color: var(--ink);
}
.nav-item.active {
  background: var(--brand-subtle);
  color: var(--ink);
  font-weight: 600;
  box-shadow: inset 3px 0 0 var(--brand);
}
.nav-item.mono {
  font-size: 13px;
}
.nav-section {
  margin: 18px 10px 6px;
  font-size: 12px;
  line-height: 16px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--ink-muted);
}
.nav-section:empty {
  margin: 12px 10px;
  border-top: 1px solid var(--border);
}
.nav-empty {
  padding: 4px 10px;
  font-size: 13px;
  color: var(--ink-muted);
}
.about {
  margin-top: auto;
  padding: 0 20px 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  color: var(--ink-faint);
}
.footer {
  padding: 16px 20px 0;
  border-top: 1px solid var(--border);
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  color: var(--ink-muted);
}

.github {
  display: inline-flex;
  color: var(--ink-muted);
  border-radius: var(--radius-sm);
}
.github:hover {
  color: var(--ink);
}
.github svg {
  width: 18px;
  height: 18px;
  fill: currentColor;
}
.add {
  font-size: 13px;
  color: var(--link);
}
.me {
  color: var(--ink);
  font-weight: 500;
  text-decoration: none;
}
.link {
  background: none;
  border: none;
  color: var(--ink-muted);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  padding: 0;
}
.link:hover {
  color: var(--ink);
}
.menu {
  margin-left: auto;
  background: var(--surface-100);
  border: 1px solid var(--border-strong);
  color: var(--ink);
  border-radius: var(--radius-md);
  padding: 5px 12px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.mobile-only {
  display: none;
}
@media (max-width: 720px) {
  .shell {
    flex-direction: column;
  }
  .sidebar {
    width: 100%;
    height: auto;
    position: static;
    padding: 12px 0;
    border-right: none;
    border-bottom: 1px solid var(--border);
  }
  .brand {
    padding: 0 16px;
  }
  .mobile-only {
    display: inline-block;
  }
  .sidebar nav,
  .sidebar .about,
  .sidebar .footer {
    display: none;
  }
  .sidebar.open nav {
    display: flex;
    margin-top: 12px;
  }
  .sidebar.open .about {
    display: flex;
    margin-top: 12px;
    padding: 0 16px 12px;
  }
  .sidebar.open .footer {
    display: flex;
    margin-top: 12px;
    padding: 12px 16px 0;
  }
}
.content {
  flex-grow: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
</style>
