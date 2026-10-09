import { defineStore } from 'pinia';
import { http } from '../api';
import type { Instance, MyEndpoint, Overview } from '../types';

type Listener = (event: string, data: unknown) => void;

/** Shared portal state: the overview and the `/api/events` stream pages subscribe to. */
export const useAppStore = defineStore('app', {
  state: () => ({
    overview: null as Overview | null,
    /** The signed-in user's endpoints (`/api/me/endpoints`), for every role. */
    mine: [] as MyEndpoint[],
    listeners: new Set<Listener>(),
    source: null as EventSource | null,
  }),
  getters: {
    instances: (s): Instance[] => s.overview?.instances ?? [],
  },
  actions: {
    async refresh() {
      this.overview = await http.get<Overview>('/api/overview');
    },
    async refreshMine() {
      this.mine = await http.get<MyEndpoint[]>('/api/me/endpoints');
    },
    bySlug(slug: string): Instance | undefined {
      return this.instances.find((i) => i.slug === slug);
    },
    /** Opens the SSE stream once; any core event refreshes the overview (cheap) and fans out. */
    connect() {
      if (this.source || typeof EventSource === 'undefined') return;
      const source = new EventSource('/api/events');
      const names = ['instance.status', 'plugin.crashed', 'sync.completed', 'sync.failed', 'auth.lockout'];
      for (const name of names) {
        source.addEventListener(name, (e) => {
          let data: unknown = null;
          try {
            data = JSON.parse((e as MessageEvent<string>).data);
          } catch {
            /* ignore */
          }
          void this.refresh().catch(() => undefined);
          for (const l of this.listeners) l(name, data);
        });
      }
      this.source = source;
    },
    disconnect() {
      this.source?.close();
      this.source = null;
    },
    /** Subscribe to live events; returns an unsubscribe function. */
    on(listener: Listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
  },
});
