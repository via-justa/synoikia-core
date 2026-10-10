import { useQuery } from '@tanstack/vue-query';
import { toValue } from 'vue';
import type { MaybeRefOrGetter } from 'vue';
import { http } from '../api';
import type { PluginRow } from '../types';

export const pluginKeys = { all: ['plugins'] as const };

export function usePluginsQuery(enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery(() => ({
    queryKey: pluginKeys.all,
    queryFn: () => http.get<PluginRow[]>('/api/plugins'),
    enabled: toValue(enabled),
  }));
}
