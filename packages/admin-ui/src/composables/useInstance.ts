import { useQuery } from '@tanstack/vue-query';
import { toValue } from 'vue';
import type { MaybeRefOrGetter } from 'vue';
import { http } from '../api';
import type { Connection, Instance, SessionGrant } from '../types';
import { useApiMutation } from './useApiMutation';
import { overviewKeys } from './useOverview';

export const instanceKeys = {
  all: ['instances'] as const,
  one: (id: string) => ['instances', id] as const,
  connection: (id: string) => ['instances', id, 'connection'] as const,
  sessionGrants: (id: string) => ['instances', id, 'session-grants'] as const,
};

type Id = MaybeRefOrGetter<string>;
const path = (id: Id) => `/api/instances/${toValue(id)}`;

export interface SyncResult {
  added: number;
  updated: number;
  staled: number;
  pendingReview: string[];
}

export function useConnectionQuery(id: Id) {
  return useQuery(() => ({
    queryKey: instanceKeys.connection(toValue(id)),
    queryFn: () => http.get<Connection>(`${path(id)}/connection`),
  }));
}

export function useSessionGrantsQuery(id: Id) {
  return useQuery(() => ({
    queryKey: instanceKeys.sessionGrants(toValue(id)),
    queryFn: () => http.get<SessionGrant[]>(`${path(id)}/session-grants`),
  }));
}

export function useSaveConnection(id: Id) {
  return useApiMutation(
    (body: unknown) => http.put(`${path(id)}/connection`, body),
    () => [instanceKeys.connection(toValue(id)), overviewKeys.all],
  );
}

export function useTestConnection(id: Id) {
  return useApiMutation((body: unknown) =>
    http.post<{ ok: boolean; message?: string; version?: string }>(`${path(id)}/connection/test`, body),
  );
}

// A sync or a settings change can alter the catalog, levels and rules under the endpoint.
export function useSyncInstance(id: Id) {
  return useApiMutation(
    () => http.post<SyncResult>(`${path(id)}/sync`),
    () => [overviewKeys.all, instanceKeys.one(toValue(id))],
  );
}

export function useUpdateInstance(id: Id) {
  return useApiMutation(
    (body: unknown) => http.patch<Instance>(path(id), body),
    () => [overviewKeys.all, instanceKeys.one(toValue(id))],
  );
}

export function useDeleteInstance(id: Id) {
  return useApiMutation((confirm: string) => http.del(path(id), { confirm }), [overviewKeys.all]);
}

export function useRevokeSessionGrant(id: Id) {
  return useApiMutation(
    (grantId: string) => http.del(`${path(id)}/session-grants/${grantId}`),
    () => [instanceKeys.sessionGrants(toValue(id))],
  );
}
