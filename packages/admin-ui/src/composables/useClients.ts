import { useQuery } from '@tanstack/vue-query';
import { http } from '../api';
import type { Grant, OAuthClient, Token } from '../types';
import { useApiMutation } from './useApiMutation';
import { myGrantKeys, myTokenKeys } from './useMyCredentials';
import type { NewToken } from './useMyCredentials';

export const tokenKeys = { all: ['tokens'] as const };
export const oauthKeys = {
  all: ['oauth'] as const,
  clients: ['oauth', 'clients'] as const,
  grants: ['oauth', 'grants'] as const,
};

export type RevocableKind = 'tokens' | 'oauth/clients' | 'oauth/grants';

export function useTokensQuery() {
  return useQuery({ queryKey: tokenKeys.all, queryFn: () => http.get<Token[]>('/api/tokens') });
}

export function useOAuthClientsQuery() {
  return useQuery({ queryKey: oauthKeys.clients, queryFn: () => http.get<OAuthClient[]>('/api/oauth/clients') });
}

export function useOAuthGrantsQuery() {
  return useQuery({ queryKey: oauthKeys.grants, queryFn: () => http.get<Grant[]>('/api/oauth/grants') });
}

export function useCreateToken() {
  return useApiMutation(
    (body: NewToken) => http.post<Token & { token: string }>('/api/tokens', body),
    [tokenKeys.all, myTokenKeys.all],
  );
}

export function useRegisterOAuthClient() {
  return useApiMutation(
    (body: { name: string; redirectUris: string[]; confidential: boolean }) =>
      http.post<{ client_id: string; client_secret?: string; client_name: string }>('/api/oauth/clients', body),
    [oauthKeys.clients],
  );
}

// Revoking a client also ends its grants; the signed-in admin's own tokens and grants show on My profile.
export function useRevokeClientAccess() {
  return useApiMutation(
    ({ kind, id }: { kind: RevocableKind; id: string }) => http.del(`/api/${kind}/${id}`),
    [tokenKeys.all, oauthKeys.all, myTokenKeys.all, myGrantKeys.all],
  );
}
