<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { errorText } from '../../api';
import MyCredentials from '../../components/MyCredentials.vue';
import TotpEnrollment from '../../components/TotpEnrollment.vue';
import {
  useApprovalBrowsersQuery,
  useChangePassword,
  useDisableTotp,
  useProfileQuery,
  useRefreshProfile,
  useSignOutApprovalBrowsers,
  useUnlinkOidc,
} from '../../composables/useProfile';
import { useSessionStore } from '../../stores/session';
import { THEME_PREFS, getTheme, setTheme } from '../../theme';
import type { ThemePref } from '../../theme';

type Message = { kind: 'ok' | 'error'; text: string };

const session = useSessionStore();
const route = useRoute();
const profileQuery = useProfileQuery();
const browsersQuery = useApprovalBrowsersQuery();
const refreshProfile = useRefreshProfile();
const changePw = useChangePassword();
const disable = useDisableTotp();
const unlinkOidc = useUnlinkOidc();
const signOutBrowsers = useSignOutApprovalBrowsers();
const me = computed(() => profileQuery.data.value);
const approvalBrowsers = computed(() => browsersQuery.data.value ?? []);
const notes = ref<Record<string, Message>>({});
const messages = computed<Record<string, Message>>(() => {
  const loadError = profileQuery.error.value ?? browsersQuery.error.value;
  return loadError ? { load: { kind: 'error', text: errorText(loadError) }, ...notes.value } : notes.value;
});
const pw = ref({ current: '', next: '', confirm: '' });
const disableCode = ref('');
const theme = ref<ThemePref>(getTheme());
const THEME_LABELS: Record<ThemePref, string> = { auto: 'Auto', light: 'Light', dark: 'Dark' };
function pickTheme(pref: ThemePref) {
  theme.value = pref;
  setTheme(pref);
}

const OIDC_RESULT: Record<string, Message> = {
  linked: { kind: 'ok', text: 'Single sign-on linked.' },
  oidc_not_allowed: { kind: 'error', text: 'That single sign-on account is not allowed by the policy.' },
  oidc_taken: { kind: 'error', text: 'That single sign-on account is already linked to another user.' },
};

onMounted(() => {
  const q = route.query.linked ? 'linked' : typeof route.query.error === 'string' ? route.query.error : undefined;
  if (q && OIDC_RESULT[q]) notes.value = { ...notes.value, oidc: OIDC_RESULT[q]! };
});

const setMsg = (key: string, kind: 'ok' | 'error', text: string) =>
  (notes.value = { ...notes.value, [key]: { kind, text } });
const failed = (key: string) => (err: unknown) => setMsg(key, 'error', errorText(err));

function signOutApprovalBrowsers() {
  signOutBrowsers.mutate(undefined, {
    onSuccess: () =>
      setMsg('approval', 'ok', 'Approval browsers signed out. The next approval asks you to sign in again.'),
    onError: failed('approval'),
  });
}
function changePassword() {
  if (pw.value.next !== pw.value.confirm) return setMsg('pw', 'error', 'The new passwords do not match.');
  changePw.mutate(
    { currentPassword: pw.value.current, newPassword: pw.value.next },
    {
      onSuccess: () => {
        pw.value = { current: '', next: '', confirm: '' };
        setMsg('pw', 'ok', 'Password changed. Other sessions were signed out.');
      },
      onError: failed('pw'),
    },
  );
}
function disableTotp() {
  disable.mutate(disableCode.value.trim(), {
    onSuccess: () => {
      disableCode.value = '';
      setMsg('totp', 'ok', 'Two-factor authentication is off.');
    },
    onError: failed('totp'),
  });
}
function unlink() {
  unlinkOidc.mutate(undefined, {
    onSuccess: () => setMsg('oidc', 'ok', 'Single sign-on unlinked.'),
    onError: failed('oidc'),
  });
}
async function enrolled() {
  await refreshProfile();
  await session.load();
}
</script>

<template>
  <div v-if="me" class="stack">
    <p class="small muted">
      Signed in as <strong>{{ me.username }}</strong> · role <strong>{{ me.role.name }}</strong>
    </p>
    <MyCredentials />
    <section class="card">
      <h2>Appearance</h2>
      <p class="small muted">Auto follows your system setting. Saved in this browser.</p>
      <div class="segmented" role="radiogroup" aria-label="Theme">
        <button
          v-for="t in THEME_PREFS"
          :key="t"
          type="button"
          role="radio"
          :aria-checked="theme === t"
          :class="{ on: theme === t }"
          @click="pickTheme(t)"
        >
          {{ THEME_LABELS[t] }}
        </button>
      </div>
    </section>

    <section class="card">
      <h2>Password</h2>
      <form class="form-grid" @submit.prevent="changePassword">
        <div v-if="me.hasPassword" class="field">
          <label for="p-cur">Current password</label>
          <input id="p-cur" v-model="pw.current" type="password" autocomplete="current-password" />
        </div>
        <div class="field">
          <label for="p-new">New password</label>
          <input id="p-new" v-model="pw.next" type="password" autocomplete="new-password" />
        </div>
        <div class="field">
          <label for="p-conf">Confirm</label>
          <input id="p-conf" v-model="pw.confirm" type="password" autocomplete="new-password" />
        </div>
        <div class="field go">
          <button class="btn btn-primary" type="submit" :disabled="pw.next.length < 12">Change password</button>
        </div>
      </form>
      <p v-if="messages.pw" class="alert" :class="messages.pw.kind">{{ messages.pw.text }}</p>
    </section>

    <section class="card">
      <h2>Two-factor authentication</h2>
      <template v-if="me.totpEnabled">
        <p class="small"><span class="pill ok">On</span> Enter a current code (or a recovery code) to turn it off.</p>
        <form class="row" @submit.prevent="disableTotp">
          <input
            v-model="disableCode"
            aria-label="Code"
            class="code"
            inputmode="numeric"
            autocomplete="one-time-code"
            placeholder="123456"
          />
          <button class="btn btn-danger" type="submit" :disabled="!disableCode.trim()">Turn off</button>
        </form>
      </template>
      <TotpEnrollment v-else @enrolled="enrolled" />
      <p v-if="messages.totp" class="alert" :class="messages.totp.kind">{{ messages.totp.text }}</p>
    </section>

    <section class="card">
      <h2>Approval browsers</h2>
      <p class="small muted">
        Browsers where you signed in to the approval page. They approve calls without a new authenticator code, except
        for locked operations.
      </p>
      <p v-if="!approvalBrowsers.length" class="small muted">None.</p>
      <ul v-else class="small">
        <li v-for="(b, i) in approvalBrowsers" :key="i">
          {{ b.userAgent ?? 'Unknown browser' }} · last used {{ new Date(b.lastSeenAt).toLocaleString() }}
        </li>
      </ul>
      <button
        class="btn btn-danger"
        type="button"
        :disabled="!approvalBrowsers.length"
        @click="signOutApprovalBrowsers"
      >
        Sign out all approval browsers
      </button>
      <p v-if="messages.approval" class="alert" :class="messages.approval.kind">{{ messages.approval.text }}</p>
    </section>

    <section v-if="session.oidcEnabled || me.oidcLinked" class="card">
      <h2>Single sign-on</h2>
      <template v-if="me.oidcLinked">
        <p class="small"><span class="pill info">Linked</span> You can sign in with {{ session.oidcLabel }}.</p>
        <button class="btn" type="button" :disabled="!me.hasPassword" @click="unlink">Unlink</button>
        <p v-if="!me.hasPassword" class="help small muted">Set a password before unlinking.</p>
      </template>
      <a v-else class="btn" href="/auth/oidc/link">Link {{ session.oidcLabel }}</a>
      <p v-if="messages.oidc" class="alert" :class="messages.oidc.kind">{{ messages.oidc.text }}</p>
    </section>
  </div>
  <p v-else-if="messages.load" class="alert error">{{ messages.load.text }}</p>
</template>

<style scoped>
.go {
  display: flex;
  align-items: flex-end;
}
.code {
  width: 140px;
  padding: 9px 11px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
}
.alert {
  margin-top: 12px;
}
</style>
