import { useQueries, useQuery } from '@tanstack/vue-query';
import { toValue } from 'vue';
import type { MaybeRefOrGetter } from 'vue';
import { http, pathKey } from '../api';
import type { MatchField, Rule, TargetsDecl } from '../types';
import { useApiMutation } from './useApiMutation';

type Base = MaybeRefOrGetter<string>;
export type Option = { value: string; label: string };

const rulesKey = (base: Base) => pathKey(`${toValue(base)}/rules`);

export function useRulesQuery(base: Base) {
  return useQuery(() => ({
    queryKey: rulesKey(base),
    queryFn: () => http.get<Rule[]>(`${toValue(base)}/rules`),
  }));
}

/** The match fields and targets for a user's own rule editor (design §6.4). */
export function useRuleFormQuery(base: Base, enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery(() => ({
    queryKey: pathKey(`${toValue(base)}/rule-form`),
    queryFn: () =>
      http.get<{ matchProfiles: Record<string, MatchField[]>; targets: TargetsDecl | null }>(
        `${toValue(base)}/rule-form`,
      ),
    enabled: toValue(enabled),
  }));
}

/** Choices per options source; a source that fails to load offers none. */
export function useRuleOptions(base: Base, sources: MaybeRefOrGetter<string[]>) {
  return useQueries({
    queries: () =>
      toValue(sources).map((source) => ({
        queryKey: pathKey(`${toValue(base)}/options/${source}`),
        queryFn: () => http.get<Option[]>(`${toValue(base)}/options/${source}`).catch((): Option[] => []),
        select: (options: Option[]) => ({ source, options }),
      })),
    combine: (results) =>
      Object.fromEntries(results.flatMap((r) => (r.data ? [[r.data.source, r.data.options]] : []))) as Record<
        string,
        Option[]
      >,
  });
}

/** Creates a rule, or updates it when `id` is set. */
export function useSaveRule(base: Base) {
  return useApiMutation(
    ({ id, body }: { id?: string; body: unknown }) =>
      id ? http.patch(`${toValue(base)}/rules/${id}`, body) : http.post(`${toValue(base)}/rules`, body),
    () => [rulesKey(base)],
  );
}

export function useToggleRule(base: Base) {
  return useApiMutation(
    (rule: Rule) => http.patch(`${toValue(base)}/rules/${rule.id}`, { enabled: !rule.enabled }),
    () => [rulesKey(base)],
  );
}

export function useDeleteRule(base: Base) {
  return useApiMutation(
    (id: string) => http.del(`${toValue(base)}/rules/${id}`),
    () => [rulesKey(base)],
  );
}
