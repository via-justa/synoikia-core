import { useQuery } from '@tanstack/vue-query';
import { toValue } from 'vue';
import type { MaybeRefOrGetter } from 'vue';
import { http } from '../api';
import type { AvailablePlugin, PluginRow, Repo } from '../types';
import { useApiMutation } from './useApiMutation';
import { overviewKeys } from './useOverview';

export const pluginKeys = { all: ['plugins'] as const };
export const repoKeys = { all: ['plugin-repos'] as const, available: ['plugin-repos', 'available'] as const };

export function usePluginsQuery(enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery(() => ({
    queryKey: pluginKeys.all,
    queryFn: () => http.get<PluginRow[]>('/api/plugins'),
    enabled: toValue(enabled),
  }));
}

export function useAvailablePluginsQuery() {
  return useQuery({
    queryKey: repoKeys.available,
    queryFn: () => http.get<AvailablePlugin[]>('/api/plugin-repos/available'),
  });
}

export function useReposQuery() {
  return useQuery({ queryKey: repoKeys.all, queryFn: () => http.get<Repo[]>('/api/plugin-repos') });
}

// Plugins, repositories and the overview's plugin list all change together.
const write = <V = void, T = unknown>(fn: (vars: V) => Promise<T>) =>
  useApiMutation(fn, [pluginKeys.all, repoKeys.all, overviewKeys.all]);

export const useTogglePlugin = () =>
  write((p: PluginRow) => http.patch(`/api/plugins/${p.id}`, { enabled: !p.enabled }));
export const useUninstallPlugin = () => write((p: PluginRow) => http.del(`/api/plugins/${p.id}`));
export const useRescanPlugins = () => write(() => http.post('/api/plugins/rescan'));
export const useInstallPlugin = () =>
  write((body: { repoId: string; pluginId: string; version: string; confirm?: string }) =>
    http.post<{ enabled: boolean }>('/api/plugins/install', body),
  );

export const useAddRepo = () =>
  write((body: { url: string; signingMode: Repo['signingMode']; confirmPublicKey?: string }) =>
    http.post('/api/plugin-repos', body),
  );
export const useConfirmRepoKey = () =>
  write(({ id, publicKey }: { id: string; publicKey: string }) =>
    http.post(`/api/plugin-repos/${id}/confirm-key`, { publicKey }),
  );
export const useRefreshRepo = () => write((id: string) => http.post(`/api/plugin-repos/${id}/refresh`));
export const useRemoveRepo = () => write((id: string) => http.del(`/api/plugin-repos/${id}`));
