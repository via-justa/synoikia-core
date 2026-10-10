import { useQuery } from '@tanstack/vue-query';
import { http } from '../api';
import type { NewUser, PublicUser, UserPatch } from '../types';
import { useApiMutation } from './useApiMutation';
import { roleKeys } from './useRoles';

export const userKeys = { all: ['users'] as const };

// Users per role show on the Roles page, so user writes refresh the roles too.
const changed = [userKeys.all, roleKeys.all];

export function useUsersQuery() {
  return useQuery({ queryKey: userKeys.all, queryFn: () => http.get<PublicUser[]>('/api/users') });
}

export function useCreateUser() {
  return useApiMutation((body: NewUser) => http.post<PublicUser>('/api/users', body), changed);
}

export function useUpdateUser() {
  return useApiMutation(
    ({ id, ...patch }: UserPatch & { id: string }) => http.patch<PublicUser>(`/api/users/${id}`, patch),
    changed,
  );
}

export function useResetTotp() {
  return useApiMutation((id: string) => http.post<PublicUser>(`/api/users/${id}/reset-totp`), changed);
}
