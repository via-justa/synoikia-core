import { useQuery } from '@tanstack/vue-query';
import { http } from '../api';
import type { Notifier } from '../types';
import { useApiMutation } from './useApiMutation';

export const notifierKeys = { all: ['notifiers'] as const };

export function useNotifiersQuery() {
  return useQuery({ queryKey: notifierKeys.all, queryFn: () => http.get<Notifier[]>('/api/notifiers') });
}

/** Creates a channel, or updates it when `id` is set. */
export function useSaveNotifier() {
  return useApiMutation(
    ({ id, body }: { id?: string; body: unknown }) =>
      id ? http.patch(`/api/notifiers/${id}`, body) : http.post('/api/notifiers', body),
    [notifierKeys.all],
  );
}

export function useTestNotifier() {
  return useApiMutation(
    (id: string) => http.post<{ ok: boolean; error?: string }>(`/api/notifiers/${id}/test`),
    [notifierKeys.all],
  );
}

export function useDeleteNotifier() {
  return useApiMutation((id: string) => http.del(`/api/notifiers/${id}`), [notifierKeys.all]);
}
