<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { errorText, http } from '../../api';
import LevelTable from '../../components/LevelTable.vue';
import { LEVEL_LABELS } from '../../format';
import { LEVELS } from '../../types';
import type { Instance, Level, LevelView, RoleRow } from '../../types';
import AccessView from './AccessView.vue';

/** The Access tab (design §8.2): the endpoint's own levels (the Admin role's), or another role's maximums. */
const props = defineProps<{ instance: Instance }>();
const route = useRoute();
const router = useRouter();
const roles = ref<RoleRow[]>([]);
const roleId = computed(() => (typeof route.query.role === 'string' ? route.query.role : 'admin'));
const role = computed(() => roles.value.find((r) => r.id === roleId.value));
const inRole = computed(() => role.value?.instanceIds.includes(props.instance.id) ?? false);
const view = ref<LevelView>();
const error = ref<string>();
const base = computed(() => `/api/roles/${roleId.value}/endpoints/${props.instance.id}`);

async function load() {
  error.value = undefined;
  try {
    roles.value = await http.get<RoleRow[]>('/api/roles');
    view.value = roleId.value === 'admin' ? undefined : await http.get<LevelView>(`${base.value}/access`);
  } catch (err) {
    error.value = errorText(err);
  }
}
onMounted(load);
watch(roleId, load);

function pick(e: Event) {
  const id = (e.target as HTMLSelectElement).value;
  void router.replace({ query: id === 'admin' ? {} : { role: id } });
}

async function apply(fn: () => Promise<LevelView>) {
  error.value = undefined;
  try {
    view.value = await fn();
  } catch (err) {
    error.value = errorText(err);
  }
}
const setGroup = (key: string, level: Level | null) =>
  apply(() => http.put<LevelView>(`${base.value}/groups/${encodeURIComponent(key)}`, { level }));
const setOp = (opId: string, level: Level | null) =>
  apply(() => http.put<LevelView>(`${base.value}/operations/${opId}`, { level }));
function bulk(e: Event) {
  const el = e.target as HTMLSelectElement;
  const level = el.value as Level;
  el.value = '';
  void apply(() => http.post<LevelView>(`${base.value}/bulk-level`, { level }));
}
async function addToRole() {
  if (!role.value) return;
  try {
    await http.put(`/api/roles/${role.value.id}/instances`, {
      instanceIds: [...role.value.instanceIds, props.instance.id],
    });
    await load();
  } catch (err) {
    error.value = errorText(err);
  }
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
      <template v-else-if="view">
        <div class="row">
          <span class="grow" />
          <select class="select" aria-label="Set every group for this role" @change="bulk">
            <option value="" selected disabled>Set all groups…</option>
            <option v-for="l in LEVELS" :key="l" :value="l">{{ LEVEL_LABELS[l] }}</option>
          </select>
        </div>
        <LevelTable :view="view" layer="role" editable @set-group="setGroup" @set-op="setOp" />
      </template>
    </template>
  </div>
</template>
