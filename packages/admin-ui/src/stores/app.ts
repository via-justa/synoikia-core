import type { QueryClient, QueryKey } from '@tanstack/vue-query';
import { defineStore } from 'pinia';
import { overviewKeys } from '../composables/useOverview';

type Listener = (event: string, data: unknown) => void;

// Each core event and the queries it makes stale.
const EVENT_KEYS: Record<string, readonly QueryKey[]> = {
  'instance.status': [overviewKeys.all],
  'plugin.crashed': [overviewKeys.all],
  'sync.completed': [overviewKeys.all],
  'sync.failed': [overviewKeys.all],
  'auth.lockout': [overviewKeys.all],
};

/** The `/api/events` stream (admins only): invalidates queries and fans events out to subscribers. */
export const useAppStore = defineStore('app', () => {
  const listeners = new Set<Listener>();
  let source: EventSource | null = null;

  function connect(queryClient: QueryClient) {
    if (source || typeof EventSource === 'undefined') return;
    source = new EventSource('/api/events');
    for (const [name, keys] of Object.entries(EVENT_KEYS)) {
      source.addEventListener(name, (e) => {
        let data: unknown = null;
        try {
          data = JSON.parse((e as MessageEvent<string>).data);
        } catch {
          /* ignore */
        }
        for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
        for (const l of listeners) l(name, data);
      });
    }
  }

  function disconnect() {
    source?.close();
    source = null;
  }

  /** Subscribe to live events; returns an unsubscribe function. */
  function on(listener: Listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { connect, disconnect, on };
});
