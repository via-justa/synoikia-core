<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { errorText, http } from '../../api';
import ChipsInput from '../../components/ChipsInput.vue';
import type { Settings } from '../../types';

type Oidc = NonNullable<Settings['oidc']>;

const security = ref<Settings['security']>();
const audit = ref<Settings['audit']>();
const oidc = ref<Omit<Oidc, 'clientSecretSet'>>();
const oidcSecretSet = ref(false);
const oidcSecret = ref('');
const forceLocal = ref(false);
const adminUrl = ref<string | null>(null);
const messages = ref<Record<string, { kind: 'ok' | 'error'; text: string }>>({});

onMounted(async () => {
  try {
    const s = await http.get<Settings>('/api/settings');
    security.value = structuredClone(s.security);
    audit.value = structuredClone(s.audit);
    forceLocal.value = s.forceLocalLogin;
    adminUrl.value = s.publicAdminUrl;
    const { clientSecretSet, ...rest } = s.oidc ?? {
      enabled: false,
      issuer: '',
      clientId: '',
      scopes: 'openid email profile',
      label: 'SSO',
      allowPolicy: { emails: [], subjects: [], group: '', groupsClaim: 'groups' },
      autoProvision: false,
      clientSecretSet: false,
    };
    oidc.value = structuredClone(rest);
    oidcSecretSet.value = clientSecretSet;
  } catch (err) {
    messages.value = { load: { kind: 'error', text: errorText(err) } };
  }
});

async function saveSection(key: 'security' | 'audit') {
  try {
    const body = key === 'security' ? security.value : audit.value;
    const res = await http.put<Record<string, unknown>>(`/api/settings/${key}`, body);
    if (key === 'security') security.value = res as Settings['security'];
    else audit.value = res as Settings['audit'];
    messages.value = { ...messages.value, [key]: { kind: 'ok', text: 'Saved.' } };
  } catch (err) {
    messages.value = { ...messages.value, [key]: { kind: 'error', text: errorText(err) } };
  }
}

async function saveOidc() {
  try {
    const res = await http.put<Oidc>('/api/settings/oidc', {
      ...oidc.value,
      ...(oidcSecret.value ? { clientSecret: oidcSecret.value } : {}),
    });
    oidcSecretSet.value = res.clientSecretSet;
    oidcSecret.value = '';
    messages.value = { ...messages.value, oidc: { kind: 'ok', text: 'Saved.' } };
  } catch (err) {
    messages.value = { ...messages.value, oidc: { kind: 'error', text: errorText(err) } };
  }
}
const callbackUrl = () => `${adminUrl.value ?? window.location.origin}/auth/oidc/callback`;
</script>

<template>
  <div class="stack">
    <p v-if="messages.load" class="alert error">{{ messages.load.text }}</p>

    <form v-if="security" class="card" @submit.prevent="saveSection('security')">
      <h2>Sign-in</h2>
      <div class="field check">
        <label
          ><input v-model="security.requireTotp" type="checkbox" /> Require two-factor authentication for password
          sign-in</label
        >
      </div>
      <div class="field check">
        <label>
          <input v-model="security.disableLocalLogin" type="checkbox" />
          Disable password sign-in (single sign-on only)
        </label>
        <p class="help">
          Needs working OIDC and at least one linked user.
          <template v-if="forceLocal">
            <strong>ADMIN_FORCE_LOCAL_LOGIN</strong> is set, so password sign-in stays on.</template
          >
        </p>
      </div>
      <div class="form-grid">
        <div class="field">
          <label for="s-idle">Session idle timeout (minutes)</label>
          <input id="s-idle" v-model.number="security.sessionIdleMinutes" type="number" min="5" />
        </div>
        <div class="field">
          <label for="s-abs">Session maximum (hours)</label>
          <input id="s-abs" v-model.number="security.sessionAbsoluteHours" type="number" min="1" />
        </div>
        <div class="field">
          <label for="s-aidle">Approval page sign-in idle timeout (hours)</label>
          <input id="s-aidle" v-model.number="security.approvalSessionIdleHours" type="number" min="1" max="168" />
        </div>
        <div class="field">
          <label for="s-aabs">Approval page sign-in maximum (days)</label>
          <input id="s-aabs" v-model.number="security.approvalSessionAbsoluteDays" type="number" min="1" max="30" />
        </div>
      </div>
      <p class="help">
        The approval page asks for an authenticator code once per browser sign-in. Locked operations always ask for a
        fresh one.
      </p>
      <p v-if="messages.security" class="alert" :class="messages.security.kind">{{ messages.security.text }}</p>
      <button class="btn btn-primary" type="submit">Save</button>
    </form>

    <form v-if="oidc" class="card" @submit.prevent="saveOidc">
      <h2>Single sign-on (OIDC)</h2>
      <div class="field check">
        <label><input v-model="oidc.enabled" type="checkbox" /> Enabled</label>
      </div>
      <div class="form-grid">
        <div class="field">
          <label for="o-iss">Issuer URL</label>
          <input id="o-iss" v-model="oidc.issuer" placeholder="https://auth.example.com/application/o/mcp/" />
        </div>
        <div class="field">
          <label for="o-cid">Client ID</label>
          <input id="o-cid" v-model="oidc.clientId" />
        </div>
        <div class="field">
          <label for="o-sec">Client secret</label>
          <input
            id="o-sec"
            v-model="oidcSecret"
            type="password"
            autocomplete="new-password"
            :placeholder="oidcSecretSet ? 'Set — leave empty to keep' : 'Not set'"
          />
        </div>
        <div class="field">
          <label for="o-lbl">Button label</label>
          <input id="o-lbl" v-model="oidc.label" />
        </div>
        <div class="field">
          <label for="o-sc">Scopes</label>
          <input id="o-sc" v-model="oidc.scopes" />
        </div>
      </div>
      <p class="small">
        Redirect URI to register with your provider: <span class="mono">{{ callbackUrl() }}</span>
      </p>
      <h2>Who may sign in</h2>
      <div class="field">
        <label>Allowed emails</label>
        <ChipsInput v-model="oidc.allowPolicy.emails" placeholder="me@example.com" />
      </div>
      <div class="form-grid">
        <div class="field">
          <label for="o-grp">Required group</label>
          <input id="o-grp" v-model="oidc.allowPolicy.group" placeholder="mcp-admins" />
        </div>
        <div class="field">
          <label for="o-gc">Groups claim</label>
          <input id="o-gc" v-model="oidc.allowPolicy.groupsClaim" />
        </div>
      </div>
      <div class="field">
        <label>Allowed subjects</label>
        <ChipsInput v-model="oidc.allowPolicy.subjects" placeholder="subject id" />
      </div>
      <div class="field check">
        <label
          ><input v-model="oidc.autoProvision" type="checkbox" /> Create an account on first sign-in for anyone the
          policy allows</label
        >
        <p class="help">Otherwise each user must link single sign-on from their profile first.</p>
      </div>
      <p v-if="messages.oidc" class="alert" :class="messages.oidc.kind">{{ messages.oidc.text }}</p>
      <button class="btn btn-primary" type="submit">Save single sign-on</button>
    </form>

    <form v-if="audit" class="card" @submit.prevent="saveSection('audit')">
      <h2>Audit log retention</h2>
      <div class="field">
        <label for="a-ret">Delete entries older than (days)</label>
        <input
          id="a-ret"
          :value="audit.retentionDays ?? ''"
          type="number"
          min="7"
          placeholder="Keep forever"
          @input="
            audit.retentionDays = ($event.target as HTMLInputElement).value
              ? Number(($event.target as HTMLInputElement).value)
              : null
          "
        />
        <p class="help">Empty keeps everything (the default). Purges are themselves audited.</p>
      </div>
      <p v-if="messages.audit" class="alert" :class="messages.audit.kind">{{ messages.audit.text }}</p>
      <button class="btn btn-primary" type="submit">Save</button>
    </form>
  </div>
</template>
