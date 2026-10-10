import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { http } from '../api';
import type { ApprovalBrowser, PublicUser } from '../types';
import { useApiMutation } from './useApiMutation';

export const profileKeys = {
  all: ['profile'] as const,
  approvalSessions: ['profile', 'approval-sessions'] as const,
};

const changed = [profileKeys.all];

export function useProfileQuery() {
  return useQuery({ queryKey: profileKeys.all, queryFn: () => http.get<PublicUser>('/api/profile') });
}

export function useApprovalBrowsersQuery() {
  return useQuery({
    queryKey: profileKeys.approvalSessions,
    queryFn: () => http.get<ApprovalBrowser[]>('/api/profile/approval-sessions'),
  });
}

export function useRefreshProfile() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: profileKeys.all });
}

export function useChangePassword() {
  return useApiMutation(
    (body: { currentPassword: string; newPassword: string }) => http.post('/api/profile/password', body),
    changed,
  );
}

export function useDisableTotp() {
  return useApiMutation((code: string) => http.post('/api/profile/totp/disable', { code }), changed);
}

export function useUnlinkOidc() {
  return useApiMutation(() => http.post('/api/profile/oidc/unlink'), changed);
}

export function useSignOutApprovalBrowsers() {
  return useApiMutation(() => http.post('/api/profile/approval-sessions/revoke'), changed);
}

// Enrollment refreshes nothing itself: the profile would switch to "On" before the recovery codes are saved.
export function useBeginTotp() {
  return useApiMutation(() => http.post<{ secret: string; uri: string }>('/api/profile/totp/begin'));
}

export function useConfirmTotp() {
  return useApiMutation((code: string) =>
    http.post<{ recoveryCodes: string[] }>('/api/profile/totp/confirm', { code }),
  );
}
