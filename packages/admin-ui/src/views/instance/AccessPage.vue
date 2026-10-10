<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { errorText } from '../../api';
import { useRolesQuery, useSetRoleInstances } from '../../composables/useRoles';
import type { Instance } from '../../types';
import AccessView from './AccessView.vue';

/** The Access tab (design §8.2): the endpoint's own levels (the Admin role's), or another role's maximums. */
const props = defineProps<{ instance: Instance }>();
const route = useRoute();
const router = useRouter();
const rolesQuery = useRolesQuery();
const setInstances = useSetRoleInstances();
const roles = computed(() => rolesQuery.data.value ?? []);
const roleId = computed(() => (typeof route.query.role === 'string' ? route.query.role : 'admin'));
const role = computed(() => roles.value.find((r) => r.id === roleId.value));
const inRole = computed(() => role.value?.instanceIds.includes(props.instance.id) ?? false);
const error = computed(
  () => setInstances.errorText.value ?? (rolesQuery.error.value ? errorText(rolesQuery.error.value) : undefined),
);

function pick(e: Event) {
  const id = (e.target as HTMLSelectElement).value;
  void router.replace({ query: id === 'admin' ? {} : { role: id } });
}

function addToRole() {
  if (!role.value) return;
  setInstances.mutate({ id: role.value.id, instanceIds: [...role.value.instanceIds, props.instance.id] });
}
</script>

<template>
  <div class="stack">
    <div v-if="roles.length > 1" class="row">
      <label class="small" for="access-role">Levels for</label>
      <select id="access-role" class="select" :value="roleId" @change="pick">
        <option v-for="r in roles" :key="r.id" :value="r.id">{{ r.name }}</option>
      </select>
      <span v-if="roleId !== 'admin'" class="small muted grow">
        The most this role can do here. It never goes above the endpoint's own (Admin) levels.
      </span>
    </div>
    <p v-if="error" class="alert error" role="alert">{{ error }}</p>
    <AccessView v-if="roleId === 'admin'" :instance="instance" />
    <template v-else-if="role">
      <div v-if="!inRole" class="card empty">
        <span class="mono">/{{ instance.slug }}</span> is not one of {{ role.name }}'s endpoints.
        <button class="btn btn-primary btn-sm" type="button" @click="addToRole">Add it to {{ role.name }}</button>
      </div>
      <AccessView v-else :key="role.id" :instance="instance" :scope="{ kind: 'role', roleId: role.id }" />
    </template>
  </div>
</template>
