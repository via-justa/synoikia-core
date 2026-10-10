import { keepPreviousData, useQueries, useQuery } from '@tanstack/vue-query';
import { toValue } from 'vue';
import type { MaybeRefOrGetter } from 'vue';
import { http, pathKey, qs } from '../api';
import type { RegistryEntry } from '../types';
import type { Option } from './useRules';

type Base = MaybeRefOrGetter<string>;
type Params = Record<string, string | number | undefined>;

const toOption = (e: RegistryEntry): Option => ({ value: e.id, label: e.name ? `${e.name} (${e.id})` : e.id });

// A registry that fails to load suggests nothing.
function registry(base: Base, params: Params) {
  return {
    queryKey: [...pathKey(`${toValue(base)}/registry`), params],
    queryFn: () =>
      http
        .get<RegistryEntry[]>(`${toValue(base)}/registry${qs(params)}`)
        .then((entries) => entries.map(toOption))
        .catch((): Option[] => []),
  };
}

/** Suggestions per registry kind, keyed by kind; a kind still loading is missing. */
export function useRegistryKinds(base: Base, kinds: MaybeRefOrGetter<string[]>) {
  return useQueries({
    queries: () =>
      toValue(kinds).map((kind) => ({
        ...registry(base, { kind, limit: 500 }),
        select: (options: Option[]) => ({ kind, options }),
      })),
    combine: (results) =>
      Object.fromEntries(results.flatMap((r) => (r.data ? [[r.data.kind, r.data.options]] : []))) as Record<
        string,
        Option[]
      >,
  });
}

/** A registry search; the previous results stay while the next search loads. */
export function useRegistrySearch(base: Base, params: MaybeRefOrGetter<Params | undefined>) {
  return useQuery(() => {
    const p = toValue(params);
    return { ...registry(base, p ?? {}), enabled: !!p, placeholderData: keepPreviousData };
  });
}
