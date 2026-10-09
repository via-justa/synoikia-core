<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { errorText, http } from '../../api';
import ModalDialog from '../../components/ModalDialog.vue';
import { ago } from '../../format';
import { useSessionStore } from '../../stores/session';
import type { PublicUser, RoleRow } from '../../types';

const session = useSessionStore();
const users = ref<PublicUser[]>([]);
const error = ref<string>();
const roles = ref<RoleRow[]>([]);
const adding = ref<{ username: string; password: string; roleId: string; note?: string }>();
const resetting = ref<{ user: PublicUser; password: string; note?: string }>();

async function load() {
  try {
    [users.value, roles.value] = await Promise.all([
      http.get<PublicUser[]>('/api/users'),
      http.get<RoleRow[]>('/api/roles'),
    ]);
  } catch (err) {
    error.value = errorText(err);
  }
}
onMounted(load);

async function act(fn: () => Promise<unknown>, confirmText?: string) {
  if (confirmText && !window.confirm(confirmText)) return;
  error.value = undefined;
  try {
    await fn();
    await load();
  } catch (err) {
    error.value = errorText(err);
  }
}

async function add() {
  const a = adding.value;
  if (!a) return;
  try {
    await http.post('/api/users', { username: a.username.trim(), password: a.password || undefined, roleId: a.roleId });
    adding.value = undefined;
    await load();
  } catch (err) {
    adding.value = { ...a, note: errorText(err) };
  }
}
async function reset() {
  const r = resetting.value;
  if (!r) return;
  try {
    await http.patch(`/api/users/${r.user.id}`, { password: r.password });
    resetting.value = undefined;
  } catch (err) {
    resetting.value = { ...r, note: errorText(err) };
  }
}
</script>

<template>
  <div class="stack">
    <div class="row">
      <p class="small muted grow">
        Each account has one role. Admins administer everything; other roles are set under
        <RouterLink to="/settings/roles">Roles</RouterLink>.
      </p>
      <button class="btn btn-primary" type="button" @click="adding = { username: '', password: '', roleId: 'admin' }">
        Add user
      </button>
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
                @change="
                  act(() => http.patch(`/api/users/${u.id}`, { roleId: ($event.target as HTMLSelectElement).value }))
                "
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
              <button class="btn btn-sm" type="button" @click="resetting = { user: u, password: '' }">
                Set password
              </button>
              <button
                v-if="u.totpEnabled"
                class="btn btn-sm"
                type="button"
                @click="
                  act(
                    () => http.post(`/api/users/${u.id}/reset-totp`),
                    `Reset two-factor for ${u.username}? They must enroll again.`,
                  )
                "
              >
                Reset 2FA
              </button>
              <button
                v-if="u.id !== session.user?.id"
                class="btn btn-sm"
                :class="{ 'btn-danger': !u.disabled }"
                type="button"
                @click="
                  act(
                    () => http.patch(`/api/users/${u.id}`, { disabled: !u.disabled }),
                    u.disabled ? undefined : `Disable ${u.username}? Their sessions end now.`,
                  )
                "
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
      <p v-if="adding.note" class="alert error">{{ adding.note }}</p>
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
      <p v-if="resetting.note" class="alert error">{{ resetting.note }}</p>
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
