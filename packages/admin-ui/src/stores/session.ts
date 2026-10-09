import { defineStore } from 'pinia';
import { http } from '../api';
import type { PublicUser, SessionInfo } from '../types';

export interface SessionState {
  loaded: boolean;
  authenticated: boolean;
  setupRequired: boolean;
  localLoginEnabled: boolean;
  signupOpen: boolean;
  oidcEnabled: boolean;
  oidcLabel: string;
  user?: PublicUser;
  mustEnrollTotp: boolean;
}

export type LoginResult = 'ok' | 'totp_required' | 'must_enroll_totp';

export const useSessionStore = defineStore('session', {
  state: (): SessionState => ({
    loaded: false,
    authenticated: false,
    setupRequired: false,
    localLoginEnabled: true,
    signupOpen: false,
    oidcEnabled: false,
    oidcLabel: 'SSO',
    user: undefined,
    mustEnrollTotp: false,
  }),
  getters: {
    username: (s) => s.user?.username,
    isAdmin: (s) => s.user?.role.isAdmin ?? false,
    role: (s) => s.user?.role,
  },
  actions: {
    async load() {
      const s = await http.get<SessionInfo>('/api/session').catch(() => null);
      this.$patch({
        loaded: true,
        authenticated: s?.authenticated ?? false,
        setupRequired: s?.setupRequired ?? false,
        localLoginEnabled: s?.localLoginEnabled ?? true,
        signupOpen: s?.signupOpen ?? false,
        oidcEnabled: s?.oidc.enabled ?? false,
        oidcLabel: s?.oidc.label ?? 'SSO',
        user: s?.user,
        mustEnrollTotp: s?.mustEnrollTotp ?? false,
      });
    },
    async login(username: string, password: string): Promise<LoginResult> {
      const res = await http.post<{ status: string; mustEnrollTotp?: boolean }>('/auth/login', { username, password });
      if (res.status === 'totp_required') return 'totp_required';
      await this.load();
      return this.mustEnrollTotp ? 'must_enroll_totp' : 'ok';
    },
    async verifyTotp(code: string): Promise<LoginResult> {
      await http.post('/auth/totp', { code });
      await this.load();
      return this.mustEnrollTotp ? 'must_enroll_totp' : 'ok';
    },
    async register(username: string, password: string): Promise<LoginResult> {
      await http.post('/auth/register', { username, password });
      await this.load();
      return this.mustEnrollTotp ? 'must_enroll_totp' : 'ok';
    },
    async setup(username: string, password: string) {
      await http.post('/api/setup', { username, password });
      await this.load();
    },
    async logout() {
      await http.post('/auth/logout').catch(() => undefined);
      this.$patch({ authenticated: false, user: undefined, mustEnrollTotp: false });
    },
  },
});
