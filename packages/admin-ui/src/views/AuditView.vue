<script setup lang="ts">
import { computed, reactive, ref, useId } from 'vue';
import { errorText, qs } from '../api';
import PageHeader from '../components/PageHeader.vue';
import { useAuditQuery } from '../composables/useAudit';
import { useInstances } from '../composables/useOverview';
import { formatDate, pretty } from '../format';

const instances = useInstances();
const PAGE = 100;
const filters = reactive({
  kind: '',
  instance: '',
  decision: '',
  operation: '',
  actor: '',
  target: '',
  from: '',
  to: '',
});
const open = ref<number>();
const uid = useId();

const query = computed(() =>
  qs({
    ...filters,
    from: filters.from ? new Date(filters.from).toISOString() : '',
    to: filters.to ? new Date(filters.to).toISOString() : '',
  }),
);
// The filters apply on submit or when paging, not while they are typed.
const request = ref({ query: query.value, offset: 0 });
const search = computed(
  () => `${request.value.query}${request.value.query ? '&' : '?'}limit=${PAGE}&offset=${request.value.offset}`,
);
const auditQuery = useAuditQuery(search);
const fetching = auditQuery.isFetching;
const rows = computed(() => auditQuery.data.value?.rows ?? []);
const total = computed(() => auditQuery.data.value?.total ?? 0);
const offset = computed(() => request.value.offset);
const error = computed(() => (auditQuery.error.value ? errorText(auditQuery.error.value) : undefined));
const slugOf = (id: string | null) => (id ? (instances.value.find((i) => i.id === id)?.slug ?? id.slice(0, 8)) : '');

function load(at = 0) {
  if (request.value.query === query.value && request.value.offset === at) void auditQuery.refetch();
  else request.value = { query: query.value, offset: at };
}
const page = (delta: number) => load(Math.max(0, offset.value + delta * PAGE));

const DECISION_CLASS = (d: string | null) =>
  !d
    ? ''
    : /denied|rejected|failed|error|timed_out|locked/.test(d)
      ? 'danger'
      : /approved|ok|login/.test(d)
        ? 'ok'
        : '';
</script>

<template>
  <div class="page">
    <PageHeader title="Audit Log" subtitle="Every call, search, configuration and sign-in event — append-only">
      <a class="btn" :href="`/api/audit/export.csv${query}`">Export CSV</a>
    </PageHeader>

    <form class="filters card" @submit.prevent="load()">
      <div class="field">
        <label for="a-kind">Kind</label>
        <select id="a-kind" v-model="filters.kind">
          <option value="">All</option>
          <option value="call">Calls</option>
          <option value="search">Searches</option>
          <option value="config">Configuration changes</option>
          <option value="auth">Sign-ins</option>
          <option value="plugin">Plugin events</option>
        </select>
      </div>
      <div class="field">
        <label for="a-inst">Endpoint</label>
        <select id="a-inst" v-model="filters.instance">
          <option value="">All</option>
          <option v-for="i in instances" :key="i.id" :value="i.id">/{{ i.slug }}</option>
        </select>
      </div>
      <div class="field">
        <label for="a-op">Operation</label>
        <input id="a-op" v-model="filters.operation" placeholder="widget.create" />
      </div>
      <div class="field">
        <label for="a-dec">Decision starts with</label>
        <input id="a-dec" v-model="filters.decision" placeholder="auto-approved" />
      </div>
      <div class="field">
        <label for="a-act">Actor</label>
        <input id="a-act" v-model="filters.actor" />
      </div>
      <div class="field">
        <label for="a-tgt">Target contains</label>
        <input id="a-tgt" v-model="filters.target" placeholder="widget.one" />
      </div>
      <div class="field">
        <label for="a-from">From</label>
        <input id="a-from" v-model="filters.from" type="datetime-local" />
      </div>
      <div class="field">
        <label for="a-to">To</label>
        <input id="a-to" v-model="filters.to" type="datetime-local" />
      </div>
      <div class="field go"><button class="btn btn-primary" type="submit">Apply</button></div>
    </form>

    <p v-if="error" class="alert error" role="alert">{{ error }}</p>

    <div class="table-card">
      <table class="table" aria-label="Audit events" :aria-busy="fetching">
        <thead>
          <tr>
            <th>Time</th>
            <th>Kind</th>
            <th>Endpoint</th>
            <th>Operation</th>
            <th>Decision</th>
            <th>Actor</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="r in rows" :key="r.id">
            <tr class="clickable" @click="open = open === r.id ? undefined : r.id">
              <td class="nowrap">
                <button
                  class="expand"
                  type="button"
                  :aria-expanded="open === r.id"
                  :aria-controls="open === r.id ? `${uid}-${r.id}` : undefined"
                >
                  {{ formatDate(r.at) }}
                </button>
              </td>
              <td>{{ r.kind }}</td>
              <td class="mono">{{ slugOf(r.instanceId) }}</td>
              <td class="mono">{{ r.operationKey }}</td>
              <td>
                <span class="pill" :class="DECISION_CLASS(r.decision)">{{ r.decision }}</span>
              </td>
              <td>
                {{ r.actorId ?? r.actorKind }}
                <div v-if="r.decidedBy" class="small muted">decided by {{ r.decidedBy }} via {{ r.decidedVia }}</div>
              </td>
            </tr>
            <tr v-if="open === r.id" :id="`${uid}-${r.id}`">
              <td colspan="6">
                <pre class="code">{{
                  pretty({
                    params: r.params,
                    resolvedTargets: r.resolvedTargets,
                    result: r.resultStatus,
                    durationMs: r.durationMs,
                    detail: r.detail,
                  })
                }}</pre>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
      <div v-if="!rows.length" class="empty">No events match.</div>
    </div>
    <div class="row pager">
      <span class="small muted">{{ total ? `${offset + 1}–${offset + rows.length} of ${total}` : '' }}</span>
      <span class="grow" />
      <button class="btn btn-sm" type="button" :disabled="offset === 0" @click="page(-1)">Newer</button>
      <button class="btn btn-sm" type="button" :disabled="offset + rows.length >= total" @click="page(1)">Older</button>
    </div>
  </div>
</template>

<style scoped>
.filters {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 0 12px;
  padding: 16px 18px 4px;
  margin-bottom: 16px;
}
.go {
  display: flex;
  align-items: flex-end;
}
.clickable {
  cursor: pointer;
}
/* The row's click opens it; the button only gives that to the keyboard, so it looks like the cell text. */
.expand {
  -webkit-appearance: none;
  appearance: none;
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  letter-spacing: inherit;
  text-align: inherit;
  cursor: inherit;
}
.nowrap {
  white-space: nowrap;
}
.pager {
  margin-top: 12px;
}
</style>
