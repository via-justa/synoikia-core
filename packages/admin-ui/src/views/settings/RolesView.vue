<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { errorText, http } from '../../api';
import { useAppStore } from '../../stores/app';
import type { RoleRow } from '../../types';

/** Roles (design §6.4): Admin is built in; each other role has endpoints, maximum levels (set on an
 * endpoint's Access page) and three switches. */
const app = useAppStore();
const roles = ref<RoleRow[]>([]);
const error = ref<string>();
const newName = ref('');

const SWITCHES = [
  {
    key: 'canSetOwnLevels',
    label: 'Set personal levels',
    help: 'Users set personal levels for their own calls, up to the role maximum.',
  },
  {
    key: 'canManageOwnRules',
    label: 'Own pre-approval rules',
    help: 'Users add rules that apply only to their own calls.',
  },
  {
    key: 'canSeeStatus',
    label: 'See endpoint status',
    help: 'Users see health, plugin and sync state of their endpoints.',
  },
] as const;

async function load() {
  try {
    roles.value = await http.get<RoleRow[]>('/api/roles');
    if (!app.overview) await app.refresh();
  } catch (err) {
    error.value = errorText(err);
  }
}
onMounted(load);

const custom = computed(() => roles.value.filter((r) => !r.isAdmin));

async function run(fn: () => Promise<unknown>) {
  error.value = undefined;
  try {
    await fn();
    await load();
  } catch (err) {
    error.value = errorText(err);
  }
}

const create = () =>
  run(async () => {
    await http.post('/api/roles', { name: newName.value.trim() });
    newName.value = '';
  });
const flip = (r: RoleRow, key: (typeof SWITCHES)[number]['key']) =>
  run(() => http.patch(`/api/roles/${r.id}`, { [key]: !r[key] }));
const rename = (r: RoleRow) => {
  const name = window.prompt('New name', r.name)?.trim();
  if (name && name !== r.name) void run(() => http.patch(`/api/roles/${r.id}`, { name }));
};
const remove = (r: RoleRow) => {
  if (window.confirm(`Delete the role ${r.name}?`)) void run(() => http.del(`/api/roles/${r.id}`));
};
const toggleEndpoint = (r: RoleRow, id: string) =>
  run(() =>
    http.put(`/api/roles/${r.id}/instances`, {
      instanceIds: r.instanceIds.includes(id) ? r.instanceIds.filter((x) => x !== id) : [...r.instanceIds, id],
    }),
  );
const slugOf = (id: string) => app.instances.find((i) => i.id === id)?.slug ?? id;
</script>

<template>
  <div class="stack">
    <p class="small muted">
      Admins do all administration and set the levels of each endpoint. Every other role gets the endpoints you pick
      here, at most the levels you set for it on each endpoint's Access page. New endpoints and new groups start at None
      for every role.
    </p>
    <p v-if="error" class="alert error" role="alert">{{ error }}</p>
    <form class="row add" @submit.prevent="create">
      <div class="field grow">
        <input v-model="newName" placeholder="New role name" aria-label="New role name" maxlength="64" />
      </div>
      <button class="btn btn-primary" type="submit" :disabled="!newName.trim()">Add role</button>
    </form>

    <div v-for="r in roles" :key="r.id" class="card role" :data-role="r.name">
      <div class="row">
        <h2 class="grow">{{ r.name }} <span v-if="r.isDefault" class="pill info">default for new users</span></h2>
        <span class="small muted">{{ r.users }} {{ r.users === 1 ? 'user' : 'users' }}</span>
        <template v-if="!r.isAdmin">
          <button class="btn btn-sm" type="button" @click="rename(r)">Rename</button>
          <button class="btn btn-sm btn-danger" type="button" @click="remove(r)">Delete</button>
        </template>
      </div>
      <p v-if="r.isAdmin" class="small muted">
        Built in. Every endpoint, at the endpoint's own levels, and every setting.
      </p>
      <template v-else>
        <div class="switches">
          <label v-for="s in SWITCHES" :key="s.key" class="row small check" :title="s.help">
            <input type="checkbox" :checked="r[s.key]" @change="flip(r, s.key)" /> {{ s.label }}
          </label>
        </div>
        <div class="small"><strong>Endpoints</strong></div>
        <div class="endpoints">
          <label v-for="i in app.instances" :key="i.id" class="row small check">
            <input type="checkbox" :checked="r.instanceIds.includes(i.id)" @change="toggleEndpoint(r, i.id)" />
            <span class="mono">/{{ i.slug }}</span>
            <RouterLink v-if="r.instanceIds.includes(i.id)" :to="`/endpoints/${i.slug}/access?role=${r.id}`">
              levels…
            </RouterLink>
          </label>
          <span v-if="!app.instances.length" class="muted small">No endpoints yet.</span>
        </div>
        <p v-if="r.instanceIds.length" class="small muted">
          Has {{ r.instanceIds.map((id) => '/' + slugOf(id)).join(', ') }}.
        </p>
      </template>
    </div>
    <p v-if="!custom.length" class="small muted">No roles besides Admin yet.</p>
  </div>
</template>

<style scoped>
.add {
  align-items: center;
}
.add .field {
  margin: 0;
}
.role {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.switches,
.endpoints {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
}
</style>
