<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { errorText, http } from '../../api';
import { AUTH_MODE_LABELS } from '../../format';
import { AUTH_MODES } from '../../types';
import type { Settings } from '../../types';

const form = ref<Settings['mcp']>();
const publicMcpUrl = ref<string | null>(null);
const message = ref<{ kind: 'ok' | 'error'; text: string }>();
const endpointPattern = computed(() => `${publicMcpUrl.value ?? '<this server>'}/<slug>`);

onMounted(async () => {
  try {
    const s = await http.get<Settings>('/api/settings');
    form.value = structuredClone(s.mcp);
    publicMcpUrl.value = s.publicMcpUrl;
  } catch (err) {
    message.value = { kind: 'error', text: errorText(err) };
  }
});

async function save() {
  try {
    form.value = await http.put<Settings['mcp']>('/api/settings/mcp', form.value);
    message.value = { kind: 'ok', text: 'Saved.' };
  } catch (err) {
    message.value = { kind: 'error', text: errorText(err) };
  }
}

/** Redirect URIs to allow on the Cloudflare Access application's Managed OAuth, per client. */
const CF_REDIRECTS = [
  {
    client: 'Claude (claude.ai and Claude Desktop connectors)',
    uris: ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'],
  },
  {
    client: 'Cloudflare MCP portal (only if you use step 6)',
    uris: [
      'https://dash.cloudflare.com/*',
      'https://<portal-hostname>/servers-callback',
      'https://oauth-callbacks.cloudflareaccess.com/cdn-cgi/access/outbound-oauth-callback',
    ],
  },
];

const copied = ref<string>();
async function copy(text: string) {
  await navigator.clipboard?.writeText(text).catch(() => undefined);
  copied.value = text;
  setTimeout(() => (copied.value = undefined), 1500);
}

const MODE_HELP: Record<string, string> = {
  external: 'A reverse proxy (Cloudflare Access, Authelia, Authentik) authenticates clients. Only use behind one.',
  bearer: 'Clients send a token created under Clients & Tokens.',
  oauth: 'Clients sign in through this server (OAuth 2.1 with PKCE) — what claude.ai connectors expect.',
  'bearer+oauth': 'Either a bearer token or OAuth.',
};
</script>

<template>
  <form v-if="form" class="stack" @submit.prevent="save">
    <section class="card about">
      <h2>How MCP access works</h2>
      <ul class="small">
        <li>
          Each endpoint is its own MCP server at
          <span class="mono">{{ endpointPattern }}</span
          >. Add it to an MCP client from the endpoint's Connection tab.
        </li>
        <li>
          An endpoint exposes two tools: <code>search</code> to explore the service's API and <code>execute</code> to
          call it. Every call goes through the endpoint's Access levels, pre-approval rules, approvals and the audit
          log.
        </li>
        <li>
          The settings below only decide <em>who can connect</em>, not what a client may do. Endpoints use the default
          authentication unless they override it in their own Settings tab.
        </li>
        <li>
          Bearer tokens are created under <RouterLink to="/clients">Clients &amp; Tokens</RouterLink>. OAuth lets a
          client sign in through this server with a portal account. External mode leaves authentication to a reverse
          proxy in front of the server.
        </li>
      </ul>
    </section>

    <section class="card">
      <h2>Default client authentication</h2>
      <p class="small muted">Endpoints use this unless they override it in their own settings.</p>
      <div class="field">
        <select v-model="form.defaultAuthMode" aria-label="Default authentication mode">
          <option v-for="m in AUTH_MODES" :key="m" :value="m">{{ AUTH_MODE_LABELS[m] }}</option>
        </select>
        <p class="help">{{ MODE_HELP[form.defaultAuthMode] }}</p>
      </div>
      <p class="small">
        Public MCP URL: <span class="mono">{{ publicMcpUrl ?? 'not set — derived from each request' }}</span>
      </p>
    </section>

    <section class="card">
      <h2>OAuth</h2>
      <p class="small muted">
        Applies to endpoints set to <strong>{{ AUTH_MODE_LABELS.oauth }}</strong> and to endpoints set to
        <strong>{{ AUTH_MODE_LABELS['bearer+oauth'] }}</strong
        >.
      </p>
      <p v-if="!publicMcpUrl" class="alert warn" data-warn="oauth-public-url">
        OAuth is off until <code>PUBLIC_MCP_URL</code> is set on the server to the address clients reach the MCP port
        on.
      </p>
      <ul class="small explain" data-explain="oauth">
        <li>
          Synoikia is the OAuth server itself, so there is no provider, client ID or secret to enter here. MCP clients
          find it from the endpoint URL.
        </li>
        <li>
          On first connect the client registers itself (if allowed below) and opens a browser. A portal account signs in
          (password and TOTP, or single sign-on), then picks which endpoints the client may use and whether it gets
          <strong>Read only</strong> or <strong>Read &amp; write</strong>.
        </li>
        <li>
          The client then gets a short-lived access token and a refresh token that changes on every use. Sign-ins always
          use PKCE.
        </li>
        <li>
          Registered clients and what each was granted are listed, and can be revoked, under
          <RouterLink to="/clients">Clients &amp; Tokens</RouterLink>.
        </li>
      </ul>
      <div class="field check">
        <label
          ><input v-model="form.allowDynamicRegistration" type="checkbox" /> Let MCP clients register themselves
          (dynamic client registration)</label
        >
        <p class="help">When off, register each client by hand under Clients &amp; Tokens.</p>
      </div>
      <div class="form-grid">
        <div class="field">
          <label for="m-at">Access token lifetime (minutes)</label>
          <input id="m-at" v-model.number="form.accessTokenTtlMinutes" type="number" min="5" max="1440" />
        </div>
        <div class="field">
          <label for="m-rt">Refresh token lifetime (days)</label>
          <input id="m-rt" v-model.number="form.refreshTokenTtlDays" type="number" min="1" max="365" />
        </div>
      </div>
    </section>

    <section class="card">
      <h2>Cloudflare Access</h2>
      <p class="small muted">
        Applies to endpoints using <strong>{{ AUTH_MODE_LABELS.external }}</strong
        >. With both fields set, every MCP request must carry a valid Cloudflare Access token
        (<code>Cf-Access-Jwt-Assertion</code>), which Synoikia checks itself; anything else gets a 401.
      </p>
      <div class="form-grid">
        <div class="field">
          <label for="m-cft">Cloudflare team domain</label>
          <input id="m-cft" v-model="form.cfAccess.teamDomain" placeholder="myteam.cloudflareaccess.com" />
          <p class="help">Zero Trust → Settings → Team name and domain.</p>
        </div>
        <div class="field">
          <label for="m-cfa">Application audience (AUD)</label>
          <input id="m-cfa" v-model="form.cfAccess.aud" />
          <p class="help">The Access application's Application Audience (AUD) Tag, on its Overview.</p>
        </div>
      </div>
      <h3>Set up Cloudflare</h3>
      <ol class="small steps" data-explain="cf-access">
        <li>
          Publish the MCP port through Cloudflare (a Tunnel public hostname or a proxied DNS record), for example
          <span class="mono">mcp.example.com</span>, and set <code>PUBLIC_MCP_URL</code> to it.
        </li>
        <li>
          In the Cloudflare dashboard go to <strong>Zero Trust → Access controls → Applications</strong>, choose
          <strong>Add an application → Self-hosted</strong>, and add that hostname. Add Allow policies for who may
          connect.
        </li>
        <li>
          In the application's <strong>Advanced settings</strong>, turn on <strong>Managed OAuth</strong> so MCP clients
          can sign in through Access. Under <strong>Allowed redirect URIs</strong>, add the callbacks of the clients you
          will use:
          <div v-for="r in CF_REDIRECTS" :key="r.client" class="redirects">
            <span class="label">{{ r.client }}</span>
            <div v-for="u in r.uris" :key="u" class="redirect">
              <pre class="code">{{ u }}</pre>
              <button class="btn btn-sm" type="button" @click="copy(u)">{{ copied === u ? 'Copied' : 'Copy' }}</button>
            </div>
          </div>
          <p class="note">
            For Claude Code and other local clients, turn on <strong>Allow localhost clients</strong> instead.
          </p>
        </li>
        <li>
          For clients that can't sign in with a browser, create a service token under
          <strong>Access controls → Service credentials</strong> and add a <strong>Service Auth</strong> policy for it.
          Those clients send <code>CF-Access-Client-Id</code> and <code>CF-Access-Client-Secret</code> headers.
        </li>
        <li>
          Copy the team domain and the application's AUD tag into the fields above, save, and set the endpoints (or the
          default above) to <strong>{{ AUTH_MODE_LABELS.external }}</strong
          >.
        </li>
        <li>
          <span class="pill">Optional</span> <strong>MCP portal</strong>, to offer several endpoints from one address.
          Skip it to connect clients straight to the endpoint URL. Go to
          <strong>Zero Trust → Access controls → AI controls → MCP servers</strong>, choose
          <strong>Add MCP server</strong>, paste the endpoint URL (<span class="mono">{{ endpointPattern }}</span
          >), and under <strong>OAuth credentials</strong> choose <strong>Automatic</strong>. Sign in with Access when
          asked. Once the server shows <strong>Ready</strong>, add it to a portal; clients then connect to
          <span class="mono">https://&lt;portal-hostname&gt;/mcp</span>.
        </li>
      </ol>
    </section>

    <section class="card">
      <h2>Other reverse proxies</h2>
      <p class="small muted">
        For endpoints using <strong>{{ AUTH_MODE_LABELS.external }}</strong> behind Authelia, Authentik or similar, when
        Cloudflare Access is not set up above. The proxy decides who gets in.
      </p>
      <div class="field">
        <label for="m-hdr">Trusted identity header</label>
        <input id="m-hdr" v-model="form.trustedIdentityHeader" placeholder="Remote-User" />
        <p class="help">Used only to attribute calls in the audit log.</p>
      </div>
    </section>

    <p v-if="message" class="alert" :class="message.kind" role="status">{{ message.text }}</p>
    <div class="actions"><button class="btn btn-primary" type="submit">Save</button></div>
  </form>
  <p v-else-if="message" class="alert error">{{ message.text }}</p>
</template>

<style scoped>
.about ul {
  margin: 0;
  padding-left: 18px;
}
.about li + li,
.explain li + li,
.steps > li + li {
  margin-top: 6px;
}
.explain,
.steps {
  margin: 10px 0 14px;
  padding-left: 18px;
}
h3 {
  margin: 16px 0 0;
  font-size: 14px;
}
.redirects {
  margin-top: 8px;
}
.label {
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-muted);
}
.redirect {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}
.redirect pre.code {
  flex: 1;
  min-width: 0;
  margin: 0;
  padding: 6px 10px;
  overflow-wrap: anywhere;
}
.note {
  margin: 8px 0 0;
}
</style>
