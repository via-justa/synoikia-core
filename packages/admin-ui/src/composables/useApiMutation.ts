import { useMutation, useQueryClient } from '@tanstack/vue-query';
import type { QueryKey } from '@tanstack/vue-query';
import { computed } from 'vue';
import { errorText } from '../api';

/** Runs a write, refreshes `invalidates` on success, and exposes a failure as `errorText`. */
export function useApiMutation<TVars = void, TData = unknown>(
  mutationFn: (vars: TVars) => Promise<TData>,
  invalidates: readonly QueryKey[] = [],
) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn,
    // Returning the promise keeps the mutation pending until the refreshed data is in.
    onSuccess: () => Promise.all(invalidates.map((queryKey) => queryClient.invalidateQueries({ queryKey }))),
  });
  const error = computed(() => (mutation.error.value ? errorText(mutation.error.value) : undefined));
  return { ...mutation, errorText: error };
}
