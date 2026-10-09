<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError } from '../api';
import BrandLockup from '../components/BrandLockup.vue';
import { useSessionStore } from '../stores/session';
import type { LoginResult } from '../stores/session';

const session = useSessionStore();
const router = useRouter();
const route = useRoute();

const OIDC_ERRORS: Record<string, string> = {
  oidc_failed: 'Single sign-on failed. Try again.',
  oidc_not_allowed: 'Your single sign-on account is not allowed to use this portal.',
  session_changed: 'Your session changed during sign-on. Try again.',
  wrong_flow: 'Single sign-on failed. Try again.',
};

const step = ref<'password' | 'totp' | 'signup'>('password');
const username = ref('');
const password = ref('');
const code = ref('');
const submitting = ref(false);
const error = ref<string | undefined>(
  typeof route.query.error === 'string' ? (OIDC_ERRORS[route.query.error] ?? 'Sign-in failed.') : undefined,
);

const redirect = computed(() => {
  const r = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
  return r.startsWith('/') && !r.startsWith('//') ? r : '/';
});
const oidcHref = computed(() => `/auth/oidc/start?returnTo=${encodeURIComponent(redirect.value)}`);
const canSubmit = computed(() =>
  step.value === 'totp'
    ? code.value.trim() !== '' && !submitting.value
    : username.value.trim() !== '' && password.value !== '' && !submitting.value,
);

async function done(result: LoginResult) {
  await router.replace(result === 'must_enroll_totp' ? '/enroll-totp' : redirect.value);
}

function message(err: unknown, fallback: string) {
  if (err instanceof ApiError) {
    if (step.value === 'signup' && err.status !== 429) return err.message;
    if (err.status === 429) return 'Too many attempts. Wait a few minutes and try again.';
    if (err.code === 'local_login_disabled') return 'Password sign-in is disabled. Use single sign-on.';
    if (err.status === 401) return fallback;
  }
  return 'Sign-in is unavailable right now. Try again later.';
}

async function submit() {
  if (!canSubmit.value) return;
  submitting.value = true;
  error.value = undefined;
  try {
    if (step.value === 'signup') {
      await done(await session.register(username.value.trim(), password.value));
    } else if (step.value === 'password') {
      const result = await session.login(username.value.trim(), password.value);
      if (result === 'totp_required') {
        step.value = 'totp';
        return;
      }
      await done(result);
    } else {
      await done(await session.verifyTotp(code.value.trim()));
    }
  } catch (err) {
    if (step.value === 'totp' && err instanceof ApiError && err.code === 'mfa_expired') {
      step.value = 'password';
      error.value = 'That took too long. Sign in again.';
    } else {
      error.value = message(err, step.value === 'password' ? 'Invalid username or password.' : 'Invalid code.');
    }
  } finally {
    password.value = '';
    code.value = '';
    submitting.value = false;
  }
}
</script>

<template>
  <main class="login">
    <form class="card login-card" @submit.prevent="submit">
      <BrandLockup tag="h1" :size="40" class="brand" />
      <p class="muted small tagline">Sign in to manage your self-hosted MCP servers.</p>

      <template v-if="step === 'password' || step === 'signup'">
        <p v-if="step === 'signup'" class="muted small hint">
          Create an account. An administrator decides what it can reach.
        </p>
        <template v-if="session.localLoginEnabled">
          <div class="field">
            <label for="username">Username</label>
            <input id="username" v-model="username" name="username" autocomplete="username" autofocus />
          </div>
          <div class="field">
            <label for="password">Password</label>
            <input
              id="password"
              v-model="password"
              name="password"
              type="password"
              :autocomplete="step === 'signup' ? 'new-password' : 'current-password'"
            />
            <p v-if="step === 'signup'" class="help">At least 12 characters.</p>
          </div>
        </template>
      </template>
      <template v-else>
        <p class="muted small hint">Enter the code from your authenticator app, or a recovery code.</p>
        <div class="field">
          <label for="code">Two-factor code</label>
          <input id="code" v-model="code" name="code" inputmode="numeric" autocomplete="one-time-code" autofocus />
        </div>
      </template>

      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <button
        v-if="step === 'totp' || session.localLoginEnabled"
        class="btn btn-primary"
        type="submit"
        :disabled="!canSubmit"
      >
        {{ submitting ? 'Signing in…' : step === 'totp' ? 'Verify' : step === 'signup' ? 'Create account' : 'Sign in' }}
      </button>
      <button
        v-if="session.signupOpen && step !== 'totp'"
        class="btn-link small"
        type="button"
        @click="
          step = step === 'signup' ? 'password' : 'signup';
          error = undefined;
        "
      >
        {{ step === 'signup' ? 'Back to sign-in' : 'Create account' }}
      </button>

      <template v-if="session.oidcEnabled && step === 'password'">
        <div v-if="session.localLoginEnabled" class="divider"><span>or</span></div>
        <a class="btn oidc" :href="oidcHref">Sign in with {{ session.oidcLabel }}</a>
      </template>
    </form>
  </main>
</template>

<style scoped>
.login {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.login-card {
  width: 360px;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.login-card .field {
  margin: 0;
}
.brand {
  justify-content: center;
  margin-bottom: 0;
}
.tagline {
  margin: 0 0 6px;
  text-align: center;
}
.hint {
  margin: 0;
}
.error {
  margin: 0;
  font-size: 13px;
  color: var(--danger-text);
}
.divider {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--ink-muted);
}
.divider::before,
.divider::after {
  content: '';
  flex: 1;
  border-top: 1px solid var(--border);
}
.oidc {
  text-align: center;
  text-decoration: none;
}
</style>
