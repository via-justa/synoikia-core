<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { errorText, http } from '../api';
import PageHeader from '../components/PageHeader.vue';
import SchemaForm from '../components/SchemaForm.vue';
import { useRefreshOverview } from '../composables/useOverview';
import { AUTH_MODE_LABELS } from '../format';
import { AUTH_MODES } from '../types';
import type { AuthMode, Instance, PluginRow } from '../types';

const refreshOverview = useRefreshOverview();
const router = useRouter();
const plugins = ref<PluginRow[]>([]);
const pluginId = ref('');
const slug = ref('');
const displayName = ref('');
const authMode = ref<AuthMode | ''>('');
const config = ref<Record<string, unknown>>({});
const secrets = ref<Record<string, string | null>>({});
const error = ref<string>();
const busy = ref(false);

const usable = computed(() => plugins.value.filter((p) => p.enabled && p.status === 'ok'));
const plugin = computed(() => usable.value.find((p) => p.pluginId === pluginId.value));
const slugOk = computed(() => /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug.value));

onMounted(async () => {
  plugins.value = await http.get<PluginRow[]>('/api/plugins').catch(() => []);
  if (usable.value.length === 1) pluginId.value = usable.value[0]!.pluginId;
});
watch(pluginId, (id) => {
  config.value = {};
  secrets.value = {};
  if (id && !slug.value) slug.value = id;
});

async function create() {
  if (!plugin.value || !slugOk.value) return;
  busy.value = true;
  error.value = undefined;
  try {
    const filled = Object.fromEntries(Object.entries(secrets.value).filter(([, v]) => v));
    const created = await http.post<Instance>('/api/instances', {
      pluginId: plugin.value.pluginId,
      slug: slug.value,
      displayName: displayName.value || undefined,
      authMode: authMode.value || null,
      connection: { ...config.value, ...filled },
    });
    await refreshOverview();
    await router.push(`/endpoints/${created.slug}/connection`);
  } catch (err) {
    error.value = errorText(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="page">
    <PageHeader title="New endpoint" subtitle="Expose one upstream system as its own MCP server at /{slug}" />

    <form class="card narrow" @submit.prevent="create">
      <div v-if="!usable.length" class="alert warn">
        No enabled plugins. Enable one under <RouterLink to="/plugins">Plugins</RouterLink> first.
      </div>
      <div class="field">
        <label for="n-plugin">Plugin</label>
        <select id="n-plugin" v-model="pluginId">
          <option value="" disabled>Choose a plugin</option>
          <option v-for="p in usable" :key="p.id" :value="p.pluginId">{{ p.manifest.name ?? p.pluginId }}</option>
        </select>
        <p v-if="plugin?.manifest.description" class="help">{{ plugin.manifest.description }}</p>
      </div>
      <div class="form-grid">
        <div class="field">
          <label for="n-slug">Path</label>
          <input id="n-slug" v-model.trim="slug" placeholder="nas" />
          <p class="help" :class="{ bad: slug && !slugOk }">
            {{ slug && !slugOk ? 'Lowercase letters, digits and dashes.' : `Served at /${slug || '…'}` }}
          </p>
        </div>
        <div class="field">
          <label for="n-name">Display name</label>
          <input id="n-name" v-model="displayName" :placeholder="plugin?.manifest.name" />
        </div>
      </div>
      <div class="field">
        <label for="n-auth">Client authentication</label>
        <select id="n-auth" v-model="authMode">
          <option value="">Use the global default</option>
          <option v-for="m in AUTH_MODES" :key="m" :value="m">{{ AUTH_MODE_LABELS[m] }}</option>
        </select>
      </div>

      <template v-if="plugin?.manifest.connection">
        <h2>Connection</h2>
        <p v-if="plugin.manifest.connection.help" class="small muted help-text">
          {{ plugin.manifest.connection.help }}
        </p>
        <SchemaForm
          v-model:config="config"
          v-model:secret-patch="secrets"
          :schema="plugin.manifest.connection.schema"
          :ui="plugin.manifest.connection.ui ?? {}"
        />
      </template>

      <p v-if="error" class="alert error" role="alert">{{ error }}</p>
      <div class="actions">
        <button class="btn btn-primary" type="submit" :disabled="!plugin || !slugOk || busy">
          {{ busy ? 'Creating…' : 'Create endpoint' }}
        </button>
      </div>
      <p class="small muted">
        New endpoints start at Ask: reads run and every write waits for your approval. Locked operations stay off.
        Change any of it on the Access page.
      </p>
    </form>
  </div>
</template>

<style scoped>
.narrow {
  max-width: 640px;
}
.bad {
  color: var(--danger-text);
}
h2 {
  margin-top: 18px;
}
.help-text {
  white-space: pre-line;
}
</style>
