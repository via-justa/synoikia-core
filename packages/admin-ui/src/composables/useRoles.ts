import { useQuery } from '@tanstack/vue-query';
import { http } from '../api';
import type { RoleRow } from '../types';

export const roleKeys = { all: ['roles'] as const };

export function useRolesQuery() {
  return useQuery({ queryKey: roleKeys.all, queryFn: () => http.get<RoleRow[]>('/api/roles') });
}
