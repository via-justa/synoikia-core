import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed } from 'vue';
import type { MaybeRefOrGetter } from 'vue';
import { http } from '../api';
import type { Overview } from '../types';

export const overviewKeys = { all: ['overview'] as const };

const getOverview = () => http.get<Overview>('/api/overview');

/** Admin-only (design §6.4): the instances, plugins and warnings. */
export function useOverviewQuery(enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery({ queryKey: overviewKeys.all, queryFn: getOverview, enabled });
}

export function useInstances() {
  const { data } = useOverviewQuery();
  return computed(() => data.value?.instances ?? []);
}

/** Fetches the overview now, ignoring `staleTime`; rejects when the call fails. */
export function useRefreshOverview() {
  const queryClient = useQueryClient();
  return () => queryClient.fetchQuery({ queryKey: overviewKeys.all, queryFn: getOverview, staleTime: 0 });
}
