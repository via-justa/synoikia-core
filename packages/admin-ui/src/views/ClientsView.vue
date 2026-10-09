<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { errorText, http } from '../api';
import ModalDialog from '../components/ModalDialog.vue';
import PageHeader from '../components/PageHeader.vue';
import { ago, formatDate } from '../format';
import { useAppStore } from '../stores/app';
import type { Ceiling, Grant, OAuthClient, PublicUser, Token } from '../types';

const ACCESS_LABELS: Record<Ceiling, string> = { read: 'Read only', write: 'Read & write' };

const app = useAppStore();
const tokens = ref<Token[]>([]);
const clients = ref<OAuthClient[]>([]);
const grants = ref<Grant[]>([]);
const usernames = ref<Map<string, string>>(new Map());
const showRevoked = ref(false);
const error = ref<string>();

async function load() {
  try {
    let users: PublicUser[];
    [tokens.value, clients.value, grants.value, users] = await Promise.all([
      http.get<Token[]>('/api/tokens'),
      http.get<OAuthClient[]>('/api/oauth/clients'),
      http.get<Grant[]>('/api/oauth/grants'),
      http.get<PublicUser[]>('/api/users'),
    ]);
    usernames.value = new Map(users.map((u) => [u.id, u.username]));
  } catch (err) {
    error.value = errorText(err);
  }
}
onMounted(() => {
  void app.refresh().catch(() => undefined);
  void load();
});

const live = <T extends { revokedAt: string | null }>(rows: T[]) =>
  showRevoked.value ? rows : rows.filter((r) => !r.revokedAt);
const scopeText = (scope: string[]) =>
  scope.includes('*')
    ? 'all endpoints'
    : scope.map((id) => `/${app.instances.find((i) => i.id === id)?.slug ?? '?'}`).join(', ');
const resourcePath = (r: string) => {
  try {
    return new URL(r).pathname;
  } catch {
    return r;
  }
};

async function revoke(kind: 'tokens' | 'oauth/clients' | 'oauth/grants', id: string, what: string) {
  if (!window.confirm(`Revoke ${what}? Clients using it lose access immediately.`)) return;
  try {
    await http.del(`/api/${kind}/${id}`);
    await load();
  } catch (err) {
    error.value = errorText(err);
  }
}

// ── new token ──
const newToken = ref<{
  name: string;
  all: boolean;
  scope: string[];
  access: Ceiling;
  expiresAt: string;
  note?: string;
}>();
const createdSecret = ref<{ title: string; lines: [string, string][] }>();
const canCreateToken = computed(
  () => !!newToken.value?.name.trim() && (newToken.value.all || newToken.value.scope.length > 0),
);
async function createToken() {
  const t = newToken.value;
  if (!t) return;
  try {
    const res = await http.post<Token & { token: string }>('/api/tokens', {
      name: t.name.trim(),
      scope: t.all ? ['*'] : t.scope,
      access: t.access,
      expiresAt: t.expiresAt ? new Date(t.expiresAt).toISOString() : null,
    });
    newToken.value = undefined;
    createdSecret.value = { title: `Token "${res.name}"`, lines: [['Bearer token', res.token]] };
    await load();
  } catch (err) {
    newToken.value = { ...t, note: errorText(err) };
  }
}

// ── new OAuth client ──
const newClient = ref<{ name: string; redirects: string; confidential: boolean; note?: string }>();
async function createClient() {
  const c = newClient.value;
  if (!c) return;
  try {
    const res = await http.post<{ client_id: string; client_secret?: string; client_name: string }>(
      '/api/oauth/clients',
      {
        name: c.name.trim(),
        redirectUris: c.redirects
          .split(/\s+/)
          .map((s) => s.trim())
          .filter(Boolean),
        confidential: c.confidential,
      },
    );
    newClient.value = undefined;
    createdSecret.value = {
      title: `OAuth client "${res.client_name}"`,
      lines: [
        ['Client ID', res.client_id],
        ...(res.client_secret ? ([['Client secret', res.client_secret]] as [string, string][]) : []),
      ],
    };
    await load();
  } catch (err) {
    newClient.value = { ...c, note: errorText(err) };
  }
}
</script>

<template>
  <div class="page">
    <PageHeader title="Clients & Tokens" subtitle="Who can connect to your MCP endpoints">
      <label class="row small"><input v-model="showRevoked" type="checkbox" /> Show revoked</label>
    </PageHeader>
    <p v-if="error" class="alert error" role="alert">{{ error }}</p>

    <section class="stack">
      <div class="row">
        <h2 class="grow">Bearer tokens</h2>
        <button
          class="btn btn-primary btn-sm"
          type="button"
          @click="newToken = { name: '', all: false, scope: [], access: 'read', expiresAt: '' }"
        >
          New token
        </button>
      </div>
      <div class="table-card">
        <table class="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Owner</th>
              <th>Endpoints</th>
              <th>Access</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in live(tokens)" :key="t.id" :class="{ off: t.revokedAt }">
              <td>{{ t.name }}</td>
              <td class="small">{{ (t.createdBy && usernames.get(t.createdBy)) ?? '—' }}</td>
              <td class="mono small">{{ scopeText(t.scope) }}</td>
              <td class="small">{{ ACCESS_LABELS[t.access] }}</td>
              <td class="small">{{ formatDate(t.createdAt) }}</td>
              <td class="small">{{ ago(t.lastUsedAt) }}</td>
              <td class="small">{{ t.expiresAt ? formatDate(t.expiresAt) : 'never' }}</td>
              <td class="right">
                <span v-if="t.revokedAt" class="pill">revoked</span>
                <button
                  v-else
                  class="btn btn-sm btn-danger"
                  type="button"
                  @click="revoke('tokens', t.id, `token “${t.name}”`)"
                >
                  Revoke
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="!live(tokens).length" class="empty">No bearer tokens.</div>
      </div>

      <div class="row">
        <h2 class="grow">OAuth clients</h2>
        <button class="btn btn-sm" type="button" @click="newClient = { name: '', redirects: '', confidential: false }">
          Register client
        </button>
      </div>
      <div class="table-card">
        <table class="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Client ID</th>
              <th>Registered</th>
              <th>Redirects</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in live(clients)" :key="c.id" :class="{ off: c.revokedAt }">
              <td>{{ c.name }} <span v-if="c.confidential" class="pill">confidential</span></td>
              <td class="mono small">{{ c.clientId }}</td>
              <td class="small">
                {{ c.registeredVia === 'dcr' ? 'self-registered' : 'by admin' }} · {{ ago(c.createdAt) }}
              </td>
              <td class="small mono">
                <div v-for="u in c.redirectUris" :key="u">{{ u }}</div>
              </td>
              <td class="right">
                <span v-if="c.revokedAt" class="pill">revoked</span>
                <button
                  v-else
                  class="btn btn-sm btn-danger"
                  type="button"
                  @click="revoke('oauth/clients', c.id, `client “${c.name}”`)"
                >
                  Revoke
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="!live(clients).length" class="empty">
          No OAuth clients yet. MCP clients register themselves on first connect.
        </div>
      </div>

      <h2>OAuth grants</h2>
      <div class="table-card">
        <table class="table">
          <thead>
            <tr>
              <th>Client</th>
              <th>User</th>
              <th>Endpoints</th>
              <th>Access</th>
              <th>Granted</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="g in live(grants)" :key="g.id" :class="{ off: g.revokedAt }">
              <td>{{ g.client.name }}</td>
              <td>{{ g.user.username }}</td>
              <td class="mono small">{{ g.resources.map(resourcePath).join(', ') }}</td>
              <td class="small">{{ ACCESS_LABELS[g.access] }}</td>
              <td class="small">{{ formatDate(g.createdAt) }}</td>
              <td class="right">
                <span v-if="g.revokedAt" class="pill">revoked</span>
                <button
                  v-else
                  class="btn btn-sm btn-danger"
                  type="button"
                  @click="revoke('oauth/grants', g.id, `${g.client.name}'s access`)"
                >
                  Revoke
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="!live(grants).length" class="empty">No grants.</div>
      </div>
    </section>

    <ModalDialog v-if="newToken" title="New bearer token" @close="newToken = undefined">
      <div class="field">
        <label for="t-name">Name</label>
        <input id="t-name" v-model="newToken.name" placeholder="claude-desktop" />
      </div>
      <div class="field">
        <label>Endpoints</label>
        <label class="row small"
          ><input v-model="newToken.all" type="checkbox" /> All endpoints, including future ones</label
        >
        <template v-if="!newToken.all">
          <label v-for="i in app.instances" :key="i.id" class="row small">
            <input v-model="newToken.scope" type="checkbox" :value="i.id" /> <span class="mono">/{{ i.slug }}</span>
          </label>
        </template>
      </div>
      <fieldset class="access">
        <legend>Access</legend>
        <label class="row small"><input v-model="newToken.access" type="radio" value="read" /> Read only</label>
        <label class="row small"
          ><input v-model="newToken.access" type="radio" value="write" /> Read &amp; write, where the endpoint's access
          levels allow writes</label
        >
      </fieldset>
      <div class="field">
        <label for="t-exp">Expires</label>
        <input id="t-exp" v-model="newToken.expiresAt" type="datetime-local" />
        <p class="help">Leave empty for no expiry.</p>
      </div>
      <p v-if="newToken.note" class="alert error">{{ newToken.note }}</p>
      <template #footer>
        <button class="btn" type="button" @click="newToken = undefined">Cancel</button>
        <button class="btn btn-primary" type="button" :disabled="!canCreateToken" @click="createToken">
          Create token
        </button>
      </template>
    </ModalDialog>

    <ModalDialog v-if="newClient" title="Register OAuth client" @close="newClient = undefined">
      <div class="field">
        <label for="c-name">Name</label>
        <input id="c-name" v-model="newClient.name" />
      </div>
      <div class="field">
        <label for="c-red">Redirect URIs (one per line)</label>
        <textarea
          id="c-red"
          v-model="newClient.redirects"
          rows="3"
          placeholder="https://claude.ai/api/mcp/auth_callback"
        />
      </div>
      <div class="field check">
        <label
          ><input v-model="newClient.confidential" type="checkbox" /> Confidential client (gets a client secret)</label
        >
      </div>
      <p v-if="newClient.note" class="alert error">{{ newClient.note }}</p>
      <template #footer>
        <button class="btn" type="button" @click="newClient = undefined">Cancel</button>
        <button
          class="btn btn-primary"
          type="button"
          :disabled="!newClient.name.trim() || !newClient.redirects.trim()"
          @click="createClient"
        >
          Register
        </button>
      </template>
    </ModalDialog>

    <ModalDialog v-if="createdSecret" :title="createdSecret.title" @close="createdSecret = undefined">
      <p class="alert warn">Copy this now. It is not shown again.</p>
      <div v-for="[label, value] in createdSecret.lines" :key="label" class="field">
        <label>{{ label }}</label>
        <pre class="code secret">{{ value }}</pre>
      </div>
      <template #footer>
        <button class="btn btn-primary" type="button" @click="createdSecret = undefined">Done</button>
      </template>
    </ModalDialog>
  </div>
</template>

<style scoped>
.access {
  border: none;
  padding: 0;
  margin: 0 0 14px;
}
.access legend {
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-muted);
  margin-bottom: 5px;
  padding: 0;
}
.access label + label {
  margin-top: 4px;
}
.off td {
  opacity: 0.55;
}
.right {
  text-align: right;
  white-space: nowrap;
}
section h2 {
  margin: 8px 0 0;
}
.secret {
  user-select: all;
}
</style>
