import { useQuery } from '@tanstack/vue-query';
import type { QueryKey } from '@tanstack/vue-query';
import { toValue } from 'vue';
import type { MaybeRefOrGetter } from 'vue';
import { http, pathKey } from '../api';
import type { GroupSummary, Level, LevelView, Operation } from '../types';
import { useApiMutation } from './useApiMutation';
import { overviewKeys } from './useOverview';
import { roleKeys } from './useRoles';

/** Whose levels: the endpoint's own (no scope), a role's maximums, or the user's personal levels (design §6.4). */
export type AccessScope = { kind: 'role'; roleId: string } | { kind: 'own' };
export interface AccessTarget {
  instanceId: string;
  scope?: AccessScope;
}

export function accessBase({ instanceId, scope }: AccessTarget) {
  if (!scope) return `/api/instances/${instanceId}`;
  return scope.kind === 'role'
    ? `/api/roles/${scope.roleId}/endpoints/${instanceId}`
    : `/api/me/endpoints/${instanceId}`;
}

type Base = MaybeRefOrGetter<string>;
type Enabled = MaybeRefOrGetter<boolean>;

function useBaseQuery<T>(base: Base, sub: string, enabled: Enabled) {
  return useQuery(() => ({
    queryKey: pathKey(`${toValue(base)}/${sub}`),
    queryFn: () => http.get<T>(`${toValue(base)}/${sub}`),
    enabled: toValue(enabled),
  }));
}

export const useGroupsQuery = (base: Base, enabled: Enabled = true) =>
  useBaseQuery<GroupSummary[]>(base, 'groups', enabled);
export const useOperationsQuery = (base: Base, enabled: Enabled = true) =>
  useBaseQuery<Operation[]>(base, 'operations', enabled);
/** A scope's levels in one view (`/access`). */
export const useLevelViewQuery = (base: Base, enabled: Enabled = true) =>
  useBaseQuery<LevelView>(base, 'access', enabled);

// The endpoint's own levels also show in the overview and cap every role's maximums.
function changed(target: AccessTarget): QueryKey[] {
  const own = pathKey(accessBase(target));
  return target.scope ? [own] : [own, overviewKeys.all, roleKeys.all];
}

function useLevelMutation<V>(
  target: MaybeRefOrGetter<AccessTarget>,
  write: (base: string, scoped: boolean, vars: V) => Promise<unknown>,
) {
  return useApiMutation(
    (vars: V) => {
      const t = toValue(target);
      return write(accessBase(t), !!t.scope, vars);
    },
    () => changed(toValue(target)),
  );
}

const group = (base: string, key: string) => `${base}/groups/${encodeURIComponent(key)}`;

/** A scope writes its own entries with PUT; the endpoint's levels are PATCHed. */
export const useSetGroupLevel = (target: MaybeRefOrGetter<AccessTarget>) =>
  useLevelMutation(target, (base, scoped, { key, level }: { key: string; level: Level | null }) =>
    scoped ? http.put(group(base, key), { level }) : http.patch(group(base, key), { level }),
  );

export const useSetAllGroups = (target: MaybeRefOrGetter<AccessTarget>) =>
  useLevelMutation(target, (base, _scoped, level: Level) => http.post(`${base}/groups/bulk-level`, { level }));

export const useRenameGroup = (target: MaybeRefOrGetter<AccessTarget>) =>
  useLevelMutation(target, (base, _scoped, { key, label }: { key: string; label: string }) =>
    http.patch(group(base, key), { label }),
  );

export const useMergeGroups = (target: MaybeRefOrGetter<AccessTarget>) =>
  useLevelMutation(target, (base, _scoped, body: { from: string[]; into: string; label?: string }) =>
    http.post(`${base}/groups/merge`, body),
  );

export const useSetOperation = (target: MaybeRefOrGetter<AccessTarget>) =>
  useLevelMutation(target, (base, scoped, { id, body }: { id: string; body: Record<string, unknown> }) =>
    scoped
      ? http.put(`${base}/operations/${id}`, { level: body.level ?? null })
      : http.patch(`${base}/operations/${id}`, body),
  );
