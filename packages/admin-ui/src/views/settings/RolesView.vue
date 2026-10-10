<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { errorText } from '../../api';
import { latestError } from '../../composables/useApiMutation';
import { useConfirm } from '../../composables/useConfirm';
import { useOverviewQuery } from '../../composables/useOverview';
import {
  useCreateRole,
  useDeleteRole,
  useRolesQuery,
  useSetRoleInstances,
  useUpdateRole,
} from '../../composables/useRoles';
import type { RoleRow } from '../../types';

/** Roles (design §6.4): Admin is built in; each other role has endpoints, maximum levels (set on an
 * endpoint's Access page) and three switches. */
const overviewQuery = useOverviewQuery();
const rolesQuery = useRolesQuery();
const createRole = useCreateRole();
const update = useUpdateRole();
const del = useDeleteRole();
const setInstances = useSetRoleInstances();
const { confirm, prompt } = useConfirm();
const instances = computed(() => overviewQuery.data.value?.instances ?? []);
const roles = computed(() => rolesQuery.data.value ?? []);
const newName = ref('');
const uid = useId();

// One page alert: the latest action's failure, else a failed load.
const error = computed(() => {
  const loadError = rolesQuery.error.value ?? overviewQuery.error.value;
  return latestError([createRole, update, del, setInstances]) ?? (loadError ? errorText(loadError) : undefined);
});

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

const custom = computed(() => roles.value.filter((r) => !r.isAdmin));

const create = () => createRole.mutate(newName.value.trim(), { onSuccess: () => (newName.value = '') });
const flip = (r: RoleRow, key: (typeof SWITCHES)[number]['key']) => update.mutate({ id: r.id, [key]: !r[key] });
const rename = async (r: RoleRow) => {
  const name = (
    await prompt({ title: `Rename ${r.name}`, label: 'New name', initial: r.name, action: 'Rename' })
  )?.trim();
  if (name && name !== r.name) update.mutate({ id: r.id, name });
};
const remove = async (r: RoleRow) => {
  if (await confirm({ title: `Delete the role ${r.name}?`, action: 'Delete', danger: true })) del.mutate(r.id);
};
const toggleEndpoint = (r: RoleRow, id: string) =>
  setInstances.mutate({
    id: r.id,
    instanceIds: r.instanceIds.includes(id) ? r.instanceIds.filter((x) => x !== id) : [...r.instanceIds, id],
  });
const slugOf = (id: string) => instances.value.find((i) => i.id === id)?.slug ?? id;
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
        <h2 :id="`${uid}-${r.id}`" class="grow">
          {{ r.name }} <span v-if="r.isDefault" class="pill info">default for new users</span>
        </h2>
        <span class="small muted">{{ r.users }} {{ r.users === 1 ? 'user' : 'users' }}</span>
        <template v-if="!r.isAdmin">
          <button class="btn btn-sm" type="button" :aria-describedby="`${uid}-${r.id}`" @click="rename(r)">
            Rename
          </button>
          <button class="btn btn-sm btn-danger" type="button" :aria-describedby="`${uid}-${r.id}`" @click="remove(r)">
            Delete
          </button>
        </template>
      </div>
      <p v-if="r.isAdmin" class="small muted">
        Built in. Every endpoint, at the endpoint's own levels, and every setting.
      </p>
      <template v-else>
        <div class="switches" role="group" :aria-labelledby="`${uid}-${r.id}`">
          <label v-for="s in SWITCHES" :key="s.key" class="row small check" :title="s.help">
            <input type="checkbox" :checked="r[s.key]" @change="flip(r, s.key)" /> {{ s.label }}
          </label>
        </div>
        <div :id="`${uid}-${r.id}-endpoints`" class="small"><strong>Endpoints</strong></div>
        <div class="endpoints" role="group" :aria-labelledby="`${uid}-${r.id} ${uid}-${r.id}-endpoints`">
          <label v-for="i in instances" :key="i.id" class="row small check">
            <input type="checkbox" :checked="r.instanceIds.includes(i.id)" @change="toggleEndpoint(r, i.id)" />
            <span class="mono">/{{ i.slug }}</span>
            <RouterLink v-if="r.instanceIds.includes(i.id)" :to="`/endpoints/${i.slug}/access?role=${r.id}`">
              levels…
            </RouterLink>
          </label>
          <span v-if="!instances.length" class="muted small">No endpoints yet.</span>
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
