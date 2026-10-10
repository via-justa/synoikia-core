<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { errorText } from '../../api';
import ChipsInput from '../../components/ChipsInput.vue';
import ModalDialog from '../../components/ModalDialog.vue';
import {
  useDeleteInstance,
  useRevokeSessionGrant,
  useSessionGrantsQuery,
  useUpdateInstance,
} from '../../composables/useInstance';
import { AUTH_MODE_LABELS } from '../../format';
import { AUTH_MODES } from '../../types';
import type { AuthMode, Instance } from '../../types';

const props = defineProps<{ instance: Instance }>();
const router = useRouter();
const id = () => props.instance.id;
const update = useUpdateInstance(id);
const del = useDeleteInstance(id);
const grantsQuery = useSessionGrantsQuery(id);
const revoke = useRevokeSessionGrant(id);

// The form is a draft taken from the instance once; a refetch of the overview leaves the edits alone.
const s = props.instance.settings;
const form = ref({
  displayName: props.instance.displayName,
  slug: props.instance.slug,
  enabled: props.instance.enabled,
  authMode: (props.instance.authMode ?? '') as AuthMode | '',
  approvalTimeoutMin: s.approvalTimeoutMs / 60_000,
  formApprovals: s.formElicitationApprovals === 'writes',
  sessionGrantMaxHours: s.sessionGrantMaxHours,
  executePerMinute: s.executePerMinute,
  writesPerMinute: s.writesPerMinute,
  sandboxTimeoutS: s.sandbox.timeoutMs / 1000,
  sandboxMemoryMb: s.sandbox.memoryMb,
  maxResultKb: s.sandbox.maxResultBytes / 1024,
  extraRedactKeys: [...s.extraRedactKeys],
  syncMaxAgeMin: s.syncMaxAgeMs / 60_000,
  memoryMb: s.memoryMb,
});
const message = ref<{ kind: 'ok' | 'error'; text: string }>();

const grants = computed(() => grantsQuery.data.value ?? []);
const grantError = computed(
  () => revoke.errorText.value ?? (grantsQuery.error.value ? errorText(grantsQuery.error.value) : undefined),
);
const revokeGrant = (grantId: string) => revoke.mutate(grantId);
const deleting = ref<{ confirm: string; note?: string }>();

// Async, not callbacks: a new slug or a delete drops this page from the refreshed overview before the navigation.
async function save() {
  message.value = undefined;
  const f = form.value;
  try {
    const updated = await update.mutateAsync({
      displayName: f.displayName,
      slug: f.slug !== props.instance.slug ? f.slug : undefined,
      enabled: f.enabled,
      authMode: f.authMode || null,
      settings: {
        approvalTimeoutMs: Math.round(f.approvalTimeoutMin * 60_000),
        formElicitationApprovals: f.formApprovals ? 'writes' : 'off',
        sessionGrantMaxHours: f.sessionGrantMaxHours,
        executePerMinute: f.executePerMinute,
        writesPerMinute: f.writesPerMinute,
        sandbox: {
          timeoutMs: Math.round(f.sandboxTimeoutS * 1000),
          memoryMb: f.sandboxMemoryMb,
          maxResultBytes: Math.round(f.maxResultKb * 1024),
        },
        extraRedactKeys: f.extraRedactKeys,
        syncMaxAgeMs: Math.round(f.syncMaxAgeMin * 60_000),
        memoryMb: f.memoryMb,
      },
    });
    if (updated.slug !== props.instance.slug) await router.replace(`/endpoints/${updated.slug}/settings`);
    message.value = { kind: 'ok', text: 'Saved.' };
  } catch (err) {
    message.value = { kind: 'error', text: errorText(err) };
  }
}

async function remove() {
  const d = deleting.value;
  if (!d) return;
  try {
    await del.mutateAsync(d.confirm);
    await router.replace('/');
  } catch (err) {
    deleting.value = { ...d, note: errorText(err) };
  }
}
</script>

<template>
  <form class="stack" @submit.prevent="save">
    <section class="card">
      <h2>General</h2>
      <div class="form-grid">
        <div class="field">
          <label for="s-name">Display name</label>
          <input id="s-name" v-model="form.displayName" />
        </div>
        <div class="field">
          <label for="s-slug">Path</label>
          <input id="s-slug" v-model.trim="form.slug" />
          <p v-if="form.slug !== instance.slug" class="help warn">
            Clients using /{{ instance.slug }} will stop working.
          </p>
        </div>
        <div class="field">
          <label for="s-auth">Client authentication</label>
          <select id="s-auth" v-model="form.authMode">
            <option value="">Global default</option>
            <option v-for="m in AUTH_MODES" :key="m" :value="m">{{ AUTH_MODE_LABELS[m] }}</option>
          </select>
        </div>
      </div>
      <div class="field check">
        <label><input v-model="form.enabled" type="checkbox" /> Endpoint enabled</label>
      </div>
    </section>

    <section class="card">
      <h2>Approvals & limits</h2>
      <div class="form-grid">
        <div class="field">
          <label for="s-timeout">Approval timeout (minutes)</label>
          <input id="s-timeout" v-model.number="form.approvalTimeoutMin" type="number" min="1" max="1440" />
        </div>
        <div class="field">
          <label for="s-exec">Executions per minute</label>
          <input id="s-exec" v-model.number="form.executePerMinute" type="number" min="1" />
        </div>
        <div class="field">
          <label for="s-writes">Writes per minute</label>
          <input id="s-writes" v-model.number="form.writesPerMinute" type="number" min="1" />
        </div>
      </div>
      <p class="small muted">
        Writes that ask are approved on an approval page that you open from the client, and you sign in there with your
        authenticator app once per browser. Clients that can't open the page themselves show the link, and the call
        continues after you decide.
      </p>
      <div class="form-grid">
        <div class="field">
          <label for="s-grant">Longest “Approve for this session” (hours)</label>
          <input id="s-grant" v-model.number="form.sessionGrantMaxHours" type="number" min="0" max="24" />
          <p class="help">
            0 turns it off. While a session approval is active, every Ask operation of that client on this endpoint runs
            without asking, except locked ones and ones that need a typed confirmation.
          </p>
        </div>
      </div>
      <div class="field check">
        <label>
          <input v-model="form.formApprovals" type="checkbox" />
          Let clients that only show forms approve ordinary writes
        </label>
      </div>
      <p v-if="form.formApprovals" class="alert warn" role="note">
        Any client connected to this endpoint could then approve its own writes, with nobody checking. Locked operations
        and ones that need a typed confirmation still need the approval page.
      </p>
    </section>

    <section class="card">
      <h2>Active session approvals</h2>
      <p v-if="grantError" class="alert error" role="alert">{{ grantError }}</p>
      <p v-if="!grants.length" class="small muted">
        None. An approver can give one from the approval page with “Approve for this session”.
      </p>
      <table v-else class="table">
        <thead>
          <tr>
            <th>Client</th>
            <th>Approved by</th>
            <th>Until</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="g in grants" :key="g.id">
            <td>{{ g.client ?? 'unknown client' }}</td>
            <td>{{ g.createdBy }}</td>
            <td>{{ new Date(g.expiresAt).toLocaleString() }}</td>
            <td><button type="button" class="btn btn-sm btn-danger" @click="revokeGrant(g.id)">Revoke</button></td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="card">
      <h2>Sandbox, sync & redaction</h2>
      <div class="form-grid">
        <div class="field">
          <label for="s-sto">Script timeout (seconds)</label>
          <input id="s-sto" v-model.number="form.sandboxTimeoutS" type="number" min="0.1" max="120" step="0.1" />
        </div>
        <div class="field">
          <label for="s-smem">Script memory (MB)</label>
          <input id="s-smem" v-model.number="form.sandboxMemoryMb" type="number" min="8" max="1024" />
        </div>
        <div class="field">
          <label for="s-res">Max result size (KB)</label>
          <input id="s-res" v-model.number="form.maxResultKb" type="number" min="1" max="4096" />
        </div>
        <div class="field">
          <label for="s-sync">Re-sync when older than (minutes)</label>
          <input id="s-sync" v-model.number="form.syncMaxAgeMin" type="number" min="1" />
        </div>
        <div class="field">
          <label for="s-pmem">Plugin process memory (MB)</label>
          <input id="s-pmem" v-model.number="form.memoryMb" type="number" min="64" max="4096" />
        </div>
      </div>
      <div class="field">
        <label for="s-redact">Extra keys to redact</label>
        <ChipsInput v-model="form.extraRedactKeys" input-id="s-redact" placeholder="api_key" />
        <p class="help">Added to the plugin's own sensitive keys in audit logs, approvals and results.</p>
      </div>
    </section>

    <p v-if="message" class="alert" :class="message.kind" role="status">{{ message.text }}</p>
    <div class="actions">
      <button class="btn btn-primary" type="submit">Save settings</button>
      <span class="grow" />
      <button class="btn btn-danger" type="button" @click="deleting = { confirm: '' }">Delete endpoint…</button>
    </div>

    <ModalDialog v-if="deleting" :title="`Delete /${instance.slug}?`" @close="deleting = undefined">
      <p class="small">
        This removes the endpoint, its catalog, access levels and rules. The audit log is kept. Clients using this path
        stop working.
      </p>
      <div class="field">
        <label for="del-confirm"
          >Type <code>{{ instance.slug }}</code> to confirm</label
        >
        <input id="del-confirm" v-model="deleting.confirm" autocomplete="off" />
      </div>
      <p v-if="deleting.note" class="alert error">{{ deleting.note }}</p>
      <template #footer>
        <button class="btn" type="button" @click="deleting = undefined">Cancel</button>
        <button
          class="btn btn-danger-solid"
          type="button"
          :disabled="deleting.confirm !== instance.slug"
          @click="remove"
        >
          Delete
        </button>
      </template>
    </ModalDialog>
  </form>
</template>

<style scoped>
.warn {
  color: var(--warning-text) !important;
}
</style>
