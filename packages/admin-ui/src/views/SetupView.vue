<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { errorText } from '../api';
import BrandLockup from '../components/BrandLockup.vue';
import { announce } from '../composables/useAnnounce';
import { useSessionStore } from '../stores/session';

const session = useSessionStore();
const router = useRouter();
const username = ref('admin');
const password = ref('');
const confirm = ref('');
const error = ref<string>();
const busy = ref(false);

const problem = computed(() => {
  if (password.value && password.value.length < 12) return 'Use at least 12 characters.';
  if (confirm.value && confirm.value !== password.value) return 'The passwords do not match.';
  return undefined;
});
const canSubmit = computed(
  () =>
    username.value.trim().length >= 2 && password.value.length >= 12 && confirm.value === password.value && !busy.value,
);

// The check updates on every keystroke, so screen readers hear it when a field is left, not as an alert.
let spoken: string | undefined;
function speakProblem() {
  if (problem.value && problem.value !== spoken) void announce(problem.value);
  spoken = problem.value;
}

async function submit() {
  if (!canSubmit.value) return;
  busy.value = true;
  error.value = undefined;
  try {
    await session.setup(username.value.trim(), password.value);
    await router.replace('/');
  } catch (err) {
    error.value = errorText(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="setup">
    <form class="card" @submit.prevent="submit">
      <BrandLockup :size="36" class="brand" />
      <h1>Create the first admin account</h1>
      <p class="muted small">
        Every account is an administrator. You can add more accounts, two-factor authentication and single sign-on later
        under Settings.
      </p>
      <div class="field">
        <label for="su">Username</label>
        <input id="su" v-model="username" autocomplete="username" />
      </div>
      <div class="field">
        <label for="sp">Password</label>
        <input
          id="sp"
          v-model="password"
          type="password"
          autocomplete="new-password"
          :aria-describedby="problem ? 'setup-problem' : undefined"
          @blur="speakProblem"
        />
      </div>
      <div class="field">
        <label for="sc">Confirm password</label>
        <input
          id="sc"
          v-model="confirm"
          type="password"
          autocomplete="new-password"
          :aria-describedby="problem ? 'setup-problem' : undefined"
          @blur="speakProblem"
        />
      </div>
      <p v-if="problem || error" id="setup-problem" class="error" :role="error ? 'alert' : undefined">
        {{ error ?? problem }}
      </p>
      <button class="btn btn-primary" type="submit" :disabled="!canSubmit">Create account</button>
    </form>
  </main>
</template>

<style scoped>
.setup {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
form {
  width: 400px;
  max-width: 100%;
}
.brand {
  margin-bottom: 20px;
}
h1 {
  font-size: 18px;
  line-height: 24px;
  margin: 0 0 6px;
}
.error {
  color: var(--danger-text);
  font-size: 13px;
}
</style>
