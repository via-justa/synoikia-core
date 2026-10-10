import { useMutation, useQueryClient } from '@tanstack/vue-query';
import type { QueryKey } from '@tanstack/vue-query';
import { computed, toValue } from 'vue';
import type { MaybeRefOrGetter, Ref } from 'vue';
import { errorText } from '../api';

/** Runs a write, refreshes `invalidates` on success, and exposes a failure as `errorText`. */
export function useApiMutation<TVars = void, TData = unknown>(
  mutationFn: (vars: TVars) => Promise<TData>,
  invalidates: MaybeRefOrGetter<readonly QueryKey[]> = [],
) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn,
    // Returning the promise keeps the mutation pending until the refreshed data is in.
    onSuccess: () => Promise.all(toValue(invalidates).map((queryKey) => queryClient.invalidateQueries({ queryKey }))),
  });
  const error = computed(() => (mutation.error.value ? errorText(mutation.error.value) : undefined));
  return { ...mutation, errorText: error };
}

/** The error of whichever mutation ran last, for one page alert over several actions. */
export function latestError(mutations: { submittedAt: Ref<number>; errorText: Ref<string | undefined> }[]) {
  return mutations
    .map((m) => ({ at: m.submittedAt.value, text: m.errorText.value }))
    .reduce((a, b) => (b.at > a.at ? b : a), { at: -1, text: undefined as string | undefined }).text;
}
