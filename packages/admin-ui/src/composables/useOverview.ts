import { useQuery } from '@tanstack/vue-query';
import { computed } from 'vue';
import type { MaybeRefOrGetter } from 'vue';
import { http } from '../api';
import type { Overview } from '../types';

export const overviewKeys = { all: ['overview'] as const };

/** Admin-only (design §6.4): the instances, plugins and warnings. */
export function useOverviewQuery(enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery({ queryKey: overviewKeys.all, queryFn: () => http.get<Overview>('/api/overview'), enabled });
}

export function useInstances() {
  const { data } = useOverviewQuery();
  return computed(() => data.value?.instances ?? []);
}
