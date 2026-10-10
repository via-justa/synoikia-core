<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { errorText } from '../api';
import { useConfirm } from '../composables/useConfirm';
import { useCreateMyToken, useMyGrantsQuery, useMyTokensQuery, useRevokeMine } from '../composables/useMyCredentials';
import { useMyEndpointsQuery } from '../composables/useMyEndpoints';
import { ago } from '../format';
import type { Ceiling } from '../types';

/** A user's own MCP credentials (design §6.2, §6.4): bearer tokens they create and OAuth grants they gave. */
const tokensQuery = useMyTokensQuery();
const grantsQuery = useMyGrantsQuery();
const endpointsQuery = useMyEndpointsQuery();
const createToken = useCreateMyToken();
const revokeMine = useRevokeMine();
const { confirm } = useConfirm();
const uid = useId();
// The three lists show together, once all have loaded.
const ready = computed(() => !!tokensQuery.data.value && !!grantsQuery.data.value && !!endpointsQuery.data.value);
const tokens = computed(() => (ready.value ? (tokensQuery.data.value ?? []) : []));
const grants = computed(() => (ready.value ? (grantsQuery.data.value ?? []) : []));
const endpoints = computed(() => (ready.value ? endpointsQuery.endpoints.value : []));
const actionError = ref<string>();
const error = computed(() => {
  const loadError = tokensQuery.error.value ?? grantsQuery.error.value ?? endpointsQuery.error.value;
  return actionError.value ?? (loadError ? errorText(loadError) : undefined);
});
const created = ref<string>();
const draft = ref<{ name: string; all: boolean; scope: string[]; access: Ceiling; expiresAt: string }>();

const live = computed(() => tokens.value.filter((t) => !t.revokedAt));
const liveGrants = computed(() => grants.value.filter((g) => !g.revokedAt));
const slugOf = (id: string) =>
  id === '*' ? 'all my endpoints' : `/${endpoints.value.find((e) => e.id === id)?.slug ?? id}`;
const failed = (err: unknown) => (actionError.value = errorText(err));

function create() {
  const d = draft.value;
  if (!d) return;
  actionError.value = undefined;
  createToken.mutate(
    {
      name: d.name.trim(),
      scope: d.all ? ['*'] : d.scope,
      access: d.access,
      expiresAt: d.expiresAt ? new Date(d.expiresAt).toISOString() : null,
    },
    {
      onSuccess: (res) => {
        created.value = res.token;
        draft.value = undefined;
      },
      onError: failed,
    },
  );
}
async function revoke(kind: 'tokens' | 'grants', id: string, what: string) {
  const ok = await confirm({
    title: `Revoke ${what}?`,
    message: 'Clients using it lose access now.',
    action: 'Revoke',
    danger: true,
  });
  if (ok) revokeMine.mutate({ kind, id }, { onError: failed });
}
</script>

<template>
  <section class="card">
    <h2 :id="`${uid}-tokens`">My tokens</h2>
    <p class="small muted">
      Bearer tokens for MCP clients. A token reaches only your role's endpoints, at your levels, and only you can
      approve its calls.
    </p>
    <p v-if="error" class="alert error" role="alert">{{ error }}</p>
    <div v-if="created" class="alert ok" role="status">
      Copy the token now; it is not shown again: <span class="mono">{{ created }}</span>
      <button class="btn btn-sm" type="button" @click="created = undefined">Done</button>
    </div>
    <table v-if="live.length" class="table" :aria-labelledby="`${uid}-tokens`">
      <tbody>
        <tr v-for="t in live" :key="t.id">
          <td>
            <strong :id="`${uid}-${t.id}`">{{ t.name }}</strong>
            <div class="small muted">
              {{ t.scope.map(slugOf).join(', ') }} · {{ t.access === 'write' ? 'read & write' : 'read only' }}
            </div>
          </td>
          <td class="small muted">used {{ ago(t.lastUsedAt) }}</td>
          <td class="right">
            <button
              class="btn btn-sm btn-danger"
              type="button"
              :aria-describedby="`${uid}-${t.id}`"
              @click="revoke('tokens', t.id, t.name)"
            >
              Revoke
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <form v-if="draft" class="stack" @submit.prevent="create">
      <div class="field">
        <label for="t-name">Name</label>
        <input id="t-name" v-model="draft.name" maxlength="100" />
      </div>
      <div class="field" role="group" aria-label="Endpoints">
        <label class="row small check"><input v-model="draft.all" type="checkbox" /> All my endpoints</label>
        <template v-if="!draft.all">
          <label v-for="e in endpoints" :key="e.id" class="row small check">
            <input v-model="draft.scope" type="checkbox" :value="e.id" /> <span class="mono">/{{ e.slug }}</span>
          </label>
        </template>
      </div>
      <div class="field">
        <label for="t-access">Access</label>
        <select id="t-access" v-model="draft.access">
          <option value="read">Read only</option>
          <option value="write">Read &amp; write</option>
        </select>
      </div>
      <div class="field">
        <label for="t-exp">Expires (optional)</label>
        <input id="t-exp" v-model="draft.expiresAt" type="datetime-local" />
      </div>
      <div class="row">
        <button class="btn" type="button" @click="draft = undefined">Cancel</button>
        <button
          class="btn btn-primary"
          type="submit"
          :disabled="!draft.name.trim() || (!draft.all && !draft.scope.length)"
        >
          Create token
        </button>
      </div>
    </form>
    <button
      v-else
      class="btn"
      type="button"
      :disabled="!endpoints.length"
      @click="draft = { name: '', all: true, scope: [], access: 'read', expiresAt: '' }"
    >
      New token
    </button>

    <h2 :id="`${uid}-grants`" class="next">My OAuth connections</h2>
    <p v-if="!liveGrants.length" class="small muted">No client has connected with your consent.</p>
    <table v-else class="table" :aria-labelledby="`${uid}-grants`">
      <tbody>
        <tr v-for="g in liveGrants" :key="g.id">
          <td>
            <strong :id="`${uid}-${g.id}`">{{ g.client.name }}</strong>
            <div class="small muted">
              {{ g.resources.join(', ') }} · {{ g.access === 'write' ? 'read & write' : 'read only' }}
            </div>
          </td>
          <td class="small muted">since {{ ago(g.createdAt) }}</td>
          <td class="right">
            <button
              class="btn btn-sm btn-danger"
              type="button"
              :aria-describedby="`${uid}-${g.id}`"
              @click="revoke('grants', g.id, g.client.name)"
            >
              Revoke
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.next {
  margin-top: 24px;
}
.right {
  text-align: right;
}
h2 + .small {
  margin-top: 0;
}
</style>
