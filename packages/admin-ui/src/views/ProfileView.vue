<script setup lang="ts">
import { messageRole, rovingKeydown } from '../a11y';
import { computed, ref, useId } from 'vue';
import { errorText } from '../api';
import ModalDialog from '../components/ModalDialog.vue';
import MyCredentials from '../components/MyCredentials.vue';
import PageHeader from '../components/PageHeader.vue';
import RecoveryCodes from '../components/RecoveryCodes.vue';
import TotpEnrollment from '../components/TotpEnrollment.vue';
import {
  useApprovalBrowsersQuery,
  useChangePassword,
  useDisableTotp,
  useProfileQuery,
  useRefreshProfile,
  useRotateRecoveryCodes,
  useSignOutApprovalBrowsers,
} from '../composables/useProfile';
import { useSessionStore } from '../stores/session';
import { THEME_PREFS, getTheme, setTheme } from '../theme';
import type { ThemePref } from '../theme';

type Message = { kind: 'ok' | 'error'; text: string };

const session = useSessionStore();
const profileQuery = useProfileQuery();
const browsersQuery = useApprovalBrowsersQuery();
const refreshProfile = useRefreshProfile();
const changePw = useChangePassword();
const disable = useDisableTotp();
const signOutBrowsers = useSignOutApprovalBrowsers();
const rotate = useRotateRecoveryCodes();
const me = computed(() => profileQuery.data.value);
const approvalBrowsers = computed(() => browsersQuery.data.value ?? []);
const notes = ref<Record<string, Message>>({});
const messages = computed<Record<string, Message>>(() => {
  const loadError = profileQuery.error.value ?? browsersQuery.error.value;
  return loadError ? { load: { kind: 'error', text: errorText(loadError) }, ...notes.value } : notes.value;
});
const pw = ref({ current: '', next: '', confirm: '' });
const disableCode = ref('');
// Two-factor is on once confirmed, but the codes stay until the person saved them, whatever a reload says.
const showingCodes = ref(false);
const rotating = ref(false);
const rotateCode = ref('');
const rotateFormId = useId();
const newCodes = computed(() => rotate.data.value?.recoveryCodes);
const rotateError = computed(() => rotate.errorText.value);
const theme = ref<ThemePref>(getTheme());
const THEME_LABELS: Record<ThemePref, string> = { auto: 'Auto', light: 'Light', dark: 'Dark' };
function pickTheme(pref: ThemePref) {
  theme.value = pref;
  setTheme(pref);
}

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
function openRotate() {
  rotate.reset();
  rotateCode.value = '';
  rotating.value = true;
}
function rotateCodes() {
  rotate.mutate(rotateCode.value.trim(), { onSuccess: () => (rotating.value = false) });
}
async function savedNewCodes() {
  rotate.reset();
  await refreshProfile();
}
async function enrolled() {
  showingCodes.value = false;
  await refreshProfile();
  await session.load();
}
</script>

<template>
  <div class="page">
    <PageHeader title="My profile" />
    <div v-if="me" class="stack">
      <p class="small muted">
        Signed in as <strong>{{ me.username }}</strong> · role <strong>{{ me.role.name }}</strong>
      </p>
      <MyCredentials />
      <section class="card">
        <h2>Appearance</h2>
        <p id="theme-help" class="small muted">Auto follows your system setting. Saved in this browser.</p>
        <div
          class="segmented"
          role="radiogroup"
          aria-label="Theme"
          aria-describedby="theme-help"
          @keydown="rovingKeydown"
        >
          <button
            v-for="t in THEME_PREFS"
            :key="t"
            type="button"
            role="radio"
            :aria-checked="theme === t"
            :tabindex="theme === t ? 0 : -1"
            :class="{ on: theme === t }"
            @click="pickTheme(t)"
          >
            {{ THEME_LABELS[t] }}
          </button>
        </div>
      </section>

      <section v-if="me.kind === 'sso'" class="card">
        <h2>Sign-in</h2>
        <p class="small">
          You sign in with {{ session.oidcLabel }}. {{ session.oidcLabel }} keeps your password and two-factor sign-in.
        </p>
      </section>

      <section v-if="me.kind === 'local'" class="card">
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
        <p v-if="messages.pw" class="alert" :class="messages.pw.kind" :role="messageRole(messages.pw.kind)">
          {{ messages.pw.text }}
        </p>
      </section>

      <section v-if="me.kind === 'local'" class="card">
        <h2>Two-factor authentication</h2>
        <RecoveryCodes v-if="newCodes" :codes="newCodes" @saved="savedNewCodes" />
        <template v-else-if="me.totpEnabled && !showingCodes">
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
          <div class="row recovery-left">
            <span class="small">
              {{ me.recoveryCodesLeft }} recovery {{ me.recoveryCodesLeft === 1 ? 'code' : 'codes' }} left
            </span>
            <button class="btn btn-sm" type="button" @click="openRotate">New recovery codes</button>
          </div>
        </template>
        <TotpEnrollment v-else @confirmed="showingCodes = true" @enrolled="enrolled" />
        <p v-if="messages.totp" class="alert" :class="messages.totp.kind" :role="messageRole(messages.totp.kind)">
          {{ messages.totp.text }}
        </p>
      </section>

      <section class="card">
        <h2>Approval browsers</h2>
        <p class="small muted">
          Browsers where you signed in to the approval page. They approve calls without a new sign-in until the session
          ends.
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
        <p
          v-if="messages.approval"
          class="alert"
          :class="messages.approval.kind"
          :role="messageRole(messages.approval.kind)"
        >
          {{ messages.approval.text }}
        </p>
      </section>
    </div>
    <p v-else-if="messages.load" class="alert error" role="alert">{{ messages.load.text }}</p>
    <ModalDialog v-if="rotating" title="New recovery codes" @close="rotating = false">
      <form :id="rotateFormId" class="stack" @submit.prevent="rotateCodes">
        <p class="small">
          Your current recovery codes stop working. Enter the current code from your authenticator app.
        </p>
        <div class="field">
          <label :for="`${rotateFormId}-code`">Code</label>
          <input
            :id="`${rotateFormId}-code`"
            v-model="rotateCode"
            class="code"
            inputmode="numeric"
            autocomplete="one-time-code"
            placeholder="123456"
          />
        </div>
        <p v-if="rotateError" class="alert error" role="alert">{{ rotateError }}</p>
      </form>
      <template #footer>
        <button class="btn" type="button" @click="rotating = false">Cancel</button>
        <button
          class="btn btn-primary"
          type="submit"
          :form="rotateFormId"
          :disabled="!rotateCode.trim() || rotate.isPending.value"
        >
          Get new codes
        </button>
      </template>
    </ModalDialog>
  </div>
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
.recovery-left {
  margin-top: 12px;
}
</style>
