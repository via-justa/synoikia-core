<script setup lang="ts">
import { messageRole } from '../../a11y';
import { computed, ref, toRaw, watch } from 'vue';
import { errorText } from '../../api';
import ChipsInput from '../../components/ChipsInput.vue';
import { useConfirm } from '../../composables/useConfirm';
import { useRolesQuery } from '../../composables/useRoles';
import { useSaveSettings, useSettingsQuery } from '../../composables/useSettings';
import type { Settings } from '../../types';

type Oidc = NonNullable<Settings['oidc']>;
type Message = { kind: 'ok' | 'error'; text: string };

const DEFAULT_OIDC: Oidc = {
  enabled: false,
  issuer: '',
  clientId: '',
  scopes: 'openid email profile',
  label: 'SSO',
  allowPolicy: { emails: [], subjects: [], group: '', groupsClaim: 'groups' },
  autoProvision: false,
  clientSecretSet: false,
};

const settingsQuery = useSettingsQuery();
const rolesQuery = useRolesQuery();
const saves = { security: useSaveSettings('security'), audit: useSaveSettings('audit') };
const saveOidcSettings = useSaveSettings('oidc');
const { prompt } = useConfirm();
// The page shows once both have loaded.
const loaded = computed(() => (rolesQuery.data.value ? settingsQuery.data.value : undefined));
const roles = computed(() => rolesQuery.data.value ?? []);
const security = ref<Settings['security']>();
const audit = ref<Settings['audit']>();
const oidc = ref<Omit<Oidc, 'clientSecretSet'>>();
const oidcSecretSet = computed(() => loaded.value?.oidc?.clientSecretSet ?? false);
const oidcSecret = ref('');
const forceLocal = computed(() => loaded.value?.forceLocalLogin ?? false);
const adminUrl = computed(() => loaded.value?.publicAdminUrl ?? null);
const saved = ref<Record<string, Message>>({});
const messages = computed<Record<string, Message>>(() => {
  const loadError = loaded.value ? undefined : (settingsQuery.error.value ?? rolesQuery.error.value);
  return loadError ? { load: { kind: 'error', text: errorText(loadError) }, ...saved.value } : saved.value;
});

// Each form is a draft of its section; a save replaces only that section in the cache with core's answer.
watch(
  () => loaded.value?.security,
  (s) => s && (security.value = structuredClone(toRaw(s))),
  { immediate: true },
);
watch(
  () => loaded.value?.audit,
  (s) => s && (audit.value = structuredClone(toRaw(s))),
  { immediate: true },
);
watch(
  () => loaded.value && (loaded.value.oidc ?? DEFAULT_OIDC),
  (s) => {
    if (!s) return;
    const { clientSecretSet: _set, ...rest } = structuredClone(toRaw(s));
    oidc.value = rest;
  },
  { immediate: true },
);

const setMsg = (key: string, message: Message) => (saved.value = { ...saved.value, [key]: message });

async function saveSection(key: 'security' | 'audit' | 'registration') {
  // Anyone who can reach the sign-in page, or whom the proxy or the IdP lets through, becomes an admin.
  if (
    key === 'registration' &&
    security.value?.defaultRoleId === 'admin' &&
    (await prompt({
      title: 'New accounts will be administrators.',
      label: 'Type ADMIN to confirm.',
      action: 'Save',
      danger: true,
    })) !== 'ADMIN'
  )
    return;
  const section = key === 'registration' ? 'security' : key;
  saves[section].mutate(section === 'security' ? security.value : audit.value, {
    onSuccess: () => setMsg(section, { kind: 'ok', text: 'Saved.' }),
    onError: (err) => setMsg(section, { kind: 'error', text: errorText(err) }),
  });
}

function saveOidc() {
  saveOidcSettings.mutate(
    { ...oidc.value, ...(oidcSecret.value ? { clientSecret: oidcSecret.value } : {}) },
    {
      onSuccess: () => {
        oidcSecret.value = '';
        setMsg('oidc', { kind: 'ok', text: 'Saved.' });
      },
      onError: (err) => setMsg('oidc', { kind: 'error', text: errorText(err) }),
    },
  );
}
const callbackUrl = () => `${adminUrl.value ?? window.location.origin}/auth/oidc/callback`;
</script>

<template>
  <div class="stack">
    <p v-if="messages.load" class="alert error" role="alert">{{ messages.load.text }}</p>

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
      <p
        v-if="messages.security"
        class="alert"
        :class="messages.security.kind"
        :role="messageRole(messages.security.kind)"
      >
        {{ messages.security.text }}
      </p>
      <button class="btn btn-primary" type="submit">Save</button>
    </form>

    <form v-if="security" class="card" @submit.prevent="saveSection('registration')">
      <h2>Self-registration</h2>
      <div class="field">
        <label for="s-role">Role of new accounts</label>
        <select id="s-role" v-model="security.defaultRoleId">
          <option :value="null">None: nobody can register</option>
          <option v-for="r in roles" :key="r.id" :value="r.id">{{ r.name }}</option>
        </select>
        <p class="help">
          With a role set, unknown users named by the MCP proxy (External sign-in) and, with auto-provisioning on, new
          single sign-on users get an account with this role.
        </p>
        <p v-if="security.defaultRoleId === 'admin'" class="alert warn" role="status">
          Every new account will be an administrator.
        </p>
      </div>
      <div class="field check">
        <label>
          <input v-model="security.localSignup" type="checkbox" :disabled="!security.defaultRoleId" />
          Show “Create account” on the sign-in page
        </label>
      </div>
      <p
        v-if="messages.security"
        class="alert"
        :class="messages.security.kind"
        :role="messageRole(messages.security.kind)"
      >
        {{ messages.security.text }}
      </p>
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
        <label for="o-emails">Allowed emails</label>
        <ChipsInput v-model="oidc.allowPolicy.emails" input-id="o-emails" placeholder="me@example.com" />
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
        <label for="o-subjects">Allowed subjects</label>
        <ChipsInput v-model="oidc.allowPolicy.subjects" input-id="o-subjects" placeholder="subject id" />
      </div>
      <div class="field check">
        <label
          ><input v-model="oidc.autoProvision" type="checkbox" /> Create an account on first sign-in for anyone the
          policy allows</label
        >
        <p class="help">
          Otherwise each user must link single sign-on from their profile first. New accounts get the self-registration
          role, so this works only while one is set.
        </p>
      </div>
      <p v-if="messages.oidc" class="alert" :class="messages.oidc.kind" :role="messageRole(messages.oidc.kind)">
        {{ messages.oidc.text }}
      </p>
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
      <p v-if="messages.audit" class="alert" :class="messages.audit.kind" :role="messageRole(messages.audit.kind)">
        {{ messages.audit.text }}
      </p>
      <button class="btn btn-primary" type="submit">Save</button>
    </form>
  </div>
</template>
