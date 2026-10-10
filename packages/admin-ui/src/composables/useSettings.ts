import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { http } from '../api';
import type { Settings } from '../types';
import { useApiMutation } from './useApiMutation';

export const settingsKeys = { all: ['settings'] as const };

type Section = 'security' | 'audit' | 'mcp' | 'oidc';

export function useSettingsQuery() {
  return useQuery({ queryKey: settingsKeys.all, queryFn: () => http.get<Settings>('/api/settings') });
}

/** Saves one section; core's answer replaces that section in the cache, leaving the others as they are. */
export function useSaveSettings<S extends Section>(section: S) {
  const queryClient = useQueryClient();
  return useApiMutation(async (body: unknown) => {
    const saved = await http.put<NonNullable<Settings[S]>>(`/api/settings/${section}`, body);
    queryClient.setQueryData<Settings>(settingsKeys.all, (old) => old && { ...old, [section]: saved });
    return saved;
  });
}
