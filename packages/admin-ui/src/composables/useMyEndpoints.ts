import { useQuery } from '@tanstack/vue-query';
import { computed } from 'vue';
import type { MaybeRefOrGetter } from 'vue';
import { http } from '../api';
import type { MyEndpoint } from '../types';

export const myEndpointKeys = { all: ['me', 'endpoints'] as const };

/** The signed-in user's endpoints, for every role. */
export function useMyEndpointsQuery(enabled: MaybeRefOrGetter<boolean> = true) {
  const query = useQuery({
    queryKey: myEndpointKeys.all,
    queryFn: () => http.get<MyEndpoint[]>('/api/me/endpoints'),
    enabled,
  });
  return { ...query, endpoints: computed(() => query.data.value ?? []) };
}
