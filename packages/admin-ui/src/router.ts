import { createRouter, createWebHistory } from 'vue-router';
import type { RouteRecordRaw, RouterHistory } from 'vue-router';
import { setUnauthenticatedHandler } from './api';
import AppShell from './layouts/AppShell.vue';
import { useSessionStore } from './stores/session';
import AuditView from './views/AuditView.vue';
import ClientsView from './views/ClientsView.vue';
import EnrollTotpView from './views/EnrollTotpView.vue';
import AccessPage from './views/instance/AccessPage.vue';
import ConnectionView from './views/instance/ConnectionView.vue';
import InstanceLayout from './views/instance/InstanceLayout.vue';
import InstanceSettingsView from './views/instance/InstanceSettingsView.vue';
import RulesView from './views/instance/RulesView.vue';
import LoginView from './views/LoginView.vue';
import MyEndpointView from './views/MyEndpointView.vue';
import MyEndpointsView from './views/MyEndpointsView.vue';
import NewEndpointView from './views/NewEndpointView.vue';
import OverviewView from './views/OverviewView.vue';
import PluginsView from './views/PluginsView.vue';
import McpSettingsView from './views/settings/McpSettingsView.vue';
import NotificationsView from './views/settings/NotificationsView.vue';
import ProfileView from './views/settings/ProfileView.vue';
import SecuritySettingsView from './views/settings/SecuritySettingsView.vue';
import SettingsLayout from './views/settings/SettingsLayout.vue';
import RolesView from './views/settings/RolesView.vue';
import UsersView from './views/settings/UsersView.vue';
import SetupView from './views/SetupView.vue';

declare module 'vue-router' {
  interface RouteMeta {
    public?: boolean;
    title?: string;
    /** Only the Admin role (design §6.4); the API refuses the rest anyway. */
    admin?: boolean;
  }
}

const routes: RouteRecordRaw[] = [
  { path: '/login', component: LoginView, meta: { public: true, title: 'Sign in' } },
  { path: '/setup', component: SetupView, meta: { public: true, title: 'Setup' } },
  { path: '/enroll-totp', component: EnrollTotpView, meta: { title: 'Two-factor setup' } },
  {
    path: '/',
    component: AppShell,
    children: [
      { path: '', component: OverviewView, meta: { title: 'Overview', admin: true } },
      { path: 'audit', component: AuditView, meta: { title: 'Audit Log', admin: true } },
      { path: 'plugins', component: PluginsView, meta: { title: 'Plugins', admin: true } },
      { path: 'clients', component: ClientsView, meta: { title: 'Clients & Tokens', admin: true } },
      { path: 'endpoints/new', component: NewEndpointView, meta: { title: 'New endpoint', admin: true } },
      { path: 'my', component: MyEndpointsView, meta: { title: 'My endpoints' } },
      { path: 'my/:id', component: MyEndpointView, meta: { title: 'Endpoint' } },
      {
        path: 'endpoints/:slug',
        component: InstanceLayout,
        meta: { admin: true },
        children: [
          { path: '', redirect: (to) => `/endpoints/${String(to.params.slug)}/connection` },
          { path: 'connection', component: ConnectionView, meta: { title: 'Connection' } },
          { path: 'access', component: AccessPage, meta: { title: 'Access' } },
          { path: 'rules', component: RulesView, meta: { title: 'Pre-Approval Rules' } },
          { path: 'settings', component: InstanceSettingsView, meta: { title: 'Endpoint Settings' } },
        ],
      },
      {
        path: 'settings',
        component: SettingsLayout,
        children: [
          { path: '', redirect: '/settings/mcp' },
          { path: 'mcp', component: McpSettingsView, meta: { title: 'MCP access', admin: true } },
          { path: 'security', component: SecuritySettingsView, meta: { title: 'Admin UI settings', admin: true } },
          { path: 'users', component: UsersView, meta: { title: 'Users', admin: true } },
          { path: 'roles', component: RolesView, meta: { title: 'Roles', admin: true } },
          { path: 'notifications', component: NotificationsView, meta: { title: 'Notifications', admin: true } },
          { path: 'profile', component: ProfileView, meta: { title: 'My profile' } },
        ],
      },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export function createAppRouter(history: RouterHistory = createWebHistory()) {
  const router = createRouter({ history, routes });

  router.beforeEach(async (to) => {
    const session = useSessionStore();
    if (!session.loaded) await session.load();
    if (session.setupRequired) return to.path === '/setup' ? true : '/setup';
    if (to.path === '/setup') return '/';
    if (to.meta.public) return to.path === '/login' && session.authenticated ? '/' : true;
    if (!session.authenticated) {
      return { path: '/login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } };
    }
    if (session.mustEnrollTotp && to.path !== '/enroll-totp') return '/enroll-totp';
    if (to.matched.some((r) => r.meta.admin) && !session.isAdmin) return '/my';
    return true;
  });
  router.afterEach((to) => {
    if (typeof document !== 'undefined') document.title = to.meta.title ? `${to.meta.title} · Synoikia` : 'Synoikia';
  });

  // A session that expires mid-use: back to the login page, keeping the current page.
  setUnauthenticatedHandler(() => {
    const session = useSessionStore();
    session.expire();
    const current = router.currentRoute.value;
    if (!current.meta.public) void router.replace({ path: '/login', query: { redirect: current.fullPath } });
  });
  return router;
}
