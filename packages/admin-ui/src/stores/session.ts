import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { http } from '../api';
import type { PublicUser, SessionInfo } from '../types';

export type LoginResult = 'ok' | 'totp_required' | 'must_enroll_totp';

export const useSessionStore = defineStore('session', () => {
  const loaded = ref(false);
  const authenticated = ref(false);
  const setupRequired = ref(false);
  const localLoginEnabled = ref(true);
  const signupOpen = ref(false);
  const oidcEnabled = ref(false);
  const oidcLabel = ref('SSO');
  const user = ref<PublicUser>();
  const mustEnrollTotp = ref(false);

  const username = computed(() => user.value?.username);
  const isAdmin = computed(() => user.value?.role.isAdmin ?? false);
  const role = computed(() => user.value?.role);

  async function load() {
    const s = await http.get<SessionInfo>('/api/session').catch(() => null);
    loaded.value = true;
    authenticated.value = s?.authenticated ?? false;
    setupRequired.value = s?.setupRequired ?? false;
    localLoginEnabled.value = s?.localLoginEnabled ?? true;
    signupOpen.value = s?.signupOpen ?? false;
    oidcEnabled.value = s?.oidc.enabled ?? false;
    oidcLabel.value = s?.oidc.label ?? 'SSO';
    user.value = s?.user;
    mustEnrollTotp.value = s?.mustEnrollTotp ?? false;
  }

  const afterSignIn = async (): Promise<LoginResult> => {
    await load();
    return mustEnrollTotp.value ? 'must_enroll_totp' : 'ok';
  };

  async function login(name: string, password: string): Promise<LoginResult> {
    const res = await http.post<{ status: string }>('/auth/login', { username: name, password });
    if (res.status === 'totp_required') return 'totp_required';
    return afterSignIn();
  }

  async function verifyTotp(code: string): Promise<LoginResult> {
    await http.post('/auth/totp', { code });
    return afterSignIn();
  }

  async function register(name: string, password: string): Promise<LoginResult> {
    await http.post('/auth/register', { username: name, password });
    return afterSignIn();
  }

  async function setup(name: string, password: string) {
    await http.post('/api/setup', { username: name, password });
    await load();
  }

  async function logout() {
    await http.post('/auth/logout').catch(() => undefined);
    authenticated.value = false;
    user.value = undefined;
    mustEnrollTotp.value = false;
  }

  /** A session that ended server-side (a 401 mid-use). */
  function expire() {
    authenticated.value = false;
    user.value = undefined;
  }

  return {
    loaded,
    authenticated,
    setupRequired,
    localLoginEnabled,
    signupOpen,
    oidcEnabled,
    oidcLabel,
    user,
    mustEnrollTotp,
    username,
    isAdmin,
    role,
    load,
    login,
    verifyTotp,
    register,
    setup,
    logout,
    expire,
  };
});
