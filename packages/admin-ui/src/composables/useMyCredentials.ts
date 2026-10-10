import { useQuery } from '@tanstack/vue-query';
import { http } from '../api';
import type { Ceiling, Grant, Token } from '../types';
import { useApiMutation } from './useApiMutation';

export const myTokenKeys = { all: ['me', 'tokens'] as const };
export const myGrantKeys = { all: ['me', 'grants'] as const };

export interface NewToken {
  name: string;
  scope: string[];
  access: Ceiling;
  expiresAt: string | null;
}

export function useMyTokensQuery() {
  return useQuery({ queryKey: myTokenKeys.all, queryFn: () => http.get<Token[]>('/api/me/tokens') });
}

export function useMyGrantsQuery() {
  return useQuery({ queryKey: myGrantKeys.all, queryFn: () => http.get<Grant[]>('/api/me/grants') });
}

export function useCreateMyToken() {
  return useApiMutation(
    (body: NewToken) => http.post<Token & { token: string }>('/api/me/tokens', body),
    [myTokenKeys.all],
  );
}

/** Revokes one of the user's tokens or OAuth grants. */
export function useRevokeMine() {
  return useApiMutation(
    ({ kind, id }: { kind: 'tokens' | 'grants'; id: string }) => http.del(`/api/me/${kind}/${id}`),
    [myTokenKeys.all, myGrantKeys.all],
  );
}
