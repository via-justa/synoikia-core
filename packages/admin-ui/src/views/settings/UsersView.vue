<script setup lang="ts">
import { computed, ref } from 'vue';
import { errorText } from '../../api';
import ModalDialog from '../../components/ModalDialog.vue';
import { latestError } from '../../composables/useApiMutation';
import { useConfirm } from '../../composables/useConfirm';
import { useRolesQuery } from '../../composables/useRoles';
import { useCreateUser, useResetTotp, useUpdateUser, useUsersQuery } from '../../composables/useUsers';
import { ago } from '../../format';
import { useSessionStore } from '../../stores/session';
import type { PublicUser } from '../../types';

const session = useSessionStore();
const usersQuery = useUsersQuery();
const rolesQuery = useRolesQuery();
const update = useUpdateUser();
const resetTotp = useResetTotp();
const create = useCreateUser();
const setPassword = useUpdateUser();
const { confirm } = useConfirm();
const createError = create.errorText;
const passwordError = setPassword.errorText;

// Both lists show together, once both have loaded.
const ready = computed(() => !!usersQuery.data.value && !!rolesQuery.data.value);
const users = computed(() => (ready.value ? (usersQuery.data.value ?? []) : []));
const roles = computed(() => (ready.value ? (rolesQuery.data.value ?? []) : []));
const adding = ref<{ username: string; password: string; roleId: string }>();
const resetting = ref<{ user: PublicUser; password: string }>();

// One page alert: the latest row action's failure, else a failed load.
const error = computed(() => {
  const loadError = usersQuery.error.value ?? rolesQuery.error.value;
  return latestError([update, resetTotp]) ?? (loadError ? errorText(loadError) : undefined);
});

function changeRole(u: PublicUser, event: Event) {
  update.mutate({ id: u.id, roleId: (event.target as HTMLSelectElement).value });
}

async function askResetTotp(u: PublicUser) {
  const ok = await confirm({
    title: `Reset two-factor for ${u.username}?`,
    message: 'They must enroll again.',
    action: 'Reset 2FA',
    danger: true,
  });
  if (ok) resetTotp.mutate(u.id);
}

async function toggleDisabled(u: PublicUser) {
  if (!u.disabled) {
    const ok = await confirm({
      title: `Disable ${u.username}?`,
      message: 'Their sessions end now.',
      action: 'Disable',
      danger: true,
    });
    if (!ok) return;
  }
  update.mutate({ id: u.id, disabled: !u.disabled });
}

function openAdd() {
  create.reset();
  adding.value = { username: '', password: '', roleId: 'admin' };
}

function add() {
  const a = adding.value;
  if (!a) return;
  create.mutate(
    { username: a.username.trim(), password: a.password || undefined, roleId: a.roleId },
    { onSuccess: () => (adding.value = undefined) },
  );
}

function openReset(u: PublicUser) {
  setPassword.reset();
  resetting.value = { user: u, password: '' };
}

function reset() {
  const r = resetting.value;
  if (!r) return;
  setPassword.mutate({ id: r.user.id, password: r.password }, { onSuccess: () => (resetting.value = undefined) });
}
</script>

<template>
  <div class="stack">
    <div class="row">
      <p class="small muted grow">
        Each account has one role. Admins administer everything; other roles are set under
        <RouterLink to="/settings/roles">Roles</RouterLink>.
      </p>
      <button class="btn btn-primary" type="button" @click="openAdd">Add user</button>
    </div>
    <p v-if="error" class="alert error" role="alert">{{ error }}</p>
    <div class="table-card">
      <table class="table">
        <thead>
          <tr>
            <th>User</th>
            <th>Role</th>
            <th>Sign-in</th>
            <th>Last sign-in</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in users" :key="u.id" :class="{ off: u.disabled }">
            <td>
              {{ u.username }} <span v-if="u.id === session.user?.id" class="pill info">you</span>
              <span v-if="u.disabled" class="pill">disabled</span>
            </td>
            <td>
              <select
                class="select"
                :value="u.role.id"
                :aria-label="`Role of ${u.username}`"
                @change="changeRole(u, $event)"
              >
                <option v-for="r in roles" :key="r.id" :value="r.id">{{ r.name }}</option>
              </select>
            </td>
            <td class="small">
              <span v-if="u.hasPassword" class="pill">password</span>
              <span v-if="u.totpEnabled" class="pill ok">2FA</span>
              <span v-if="u.oidcLinked" class="pill info">SSO</span>
            </td>
            <td class="small">{{ ago(u.lastLoginAt) }}</td>
            <td class="right">
              <button class="btn btn-sm" type="button" @click="openReset(u)">Set password</button>
              <button v-if="u.totpEnabled" class="btn btn-sm" type="button" @click="askResetTotp(u)">Reset 2FA</button>
              <button
                v-if="u.id !== session.user?.id"
                class="btn btn-sm"
                :class="{ 'btn-danger': !u.disabled }"
                type="button"
                @click="toggleDisabled(u)"
              >
                {{ u.disabled ? 'Enable' : 'Disable' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <ModalDialog v-if="adding" title="Add user" @close="adding = undefined">
      <div class="field">
        <label for="u-name">Username</label>
        <input id="u-name" v-model="adding.username" autocomplete="off" />
      </div>
      <div class="field">
        <label for="u-pass">Password</label>
        <input id="u-pass" v-model="adding.password" type="password" autocomplete="new-password" />
        <p class="help">At least 12 characters. Leave empty for a single-sign-on-only account.</p>
      </div>
      <div class="field">
        <label for="u-role">Role</label>
        <select id="u-role" v-model="adding.roleId">
          <option v-for="r in roles" :key="r.id" :value="r.id">{{ r.name }}</option>
        </select>
      </div>
      <p v-if="createError" class="alert error">{{ createError }}</p>
      <template #footer>
        <button class="btn" type="button" @click="adding = undefined">Cancel</button>
        <button class="btn btn-primary" type="button" :disabled="adding.username.trim().length < 2" @click="add">
          Add
        </button>
      </template>
    </ModalDialog>

    <ModalDialog v-if="resetting" :title="`Set password for ${resetting.user.username}`" @close="resetting = undefined">
      <div class="field">
        <label for="r-pass">New password</label>
        <input id="r-pass" v-model="resetting.password" type="password" autocomplete="new-password" />
        <p class="help">Their existing sessions are signed out.</p>
      </div>
      <p v-if="passwordError" class="alert error">{{ passwordError }}</p>
      <template #footer>
        <button class="btn" type="button" @click="resetting = undefined">Cancel</button>
        <button class="btn btn-primary" type="button" :disabled="resetting.password.length < 12" @click="reset">
          Set password
        </button>
      </template>
    </ModalDialog>
  </div>
</template>

<style scoped>
.off td {
  opacity: 0.55;
}
.right {
  text-align: right;
  white-space: nowrap;
}
.right > * + * {
  margin-left: 6px;
}
</style>
