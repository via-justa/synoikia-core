import { keepPreviousData, useQuery } from '@tanstack/vue-query';
import { toValue } from 'vue';
import type { MaybeRefOrGetter } from 'vue';
import { http } from '../api';
import type { AuditRow } from '../types';

export const auditKeys = { all: ['audit'] as const };

/** One page of the audit log for `search` (the query string); the shown page stays while the next loads. */
export function useAuditQuery(search: MaybeRefOrGetter<string>) {
  return useQuery(() => ({
    queryKey: [...auditKeys.all, toValue(search)],
    queryFn: () => http.get<{ rows: AuditRow[]; total: number }>(`/api/audit${toValue(search)}`),
    placeholderData: keepPreviousData,
    // The log grows all the time: opening the page always asks for the newest rows.
    staleTime: 0,
  }));
}
