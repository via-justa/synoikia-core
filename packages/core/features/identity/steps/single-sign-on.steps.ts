import { Given, Then, When } from 'quickpickle';
import { expect } from 'vitest';
import type { AcmeIdentity, SynoikiaWorld } from '../../support/world.js';
import { consentPage, consentSignIn, identity, keep, newPortal } from './identity.js';

type Portal = Awaited<ReturnType<SynoikiaWorld['portalBrowser']>>;

const person = (user: number) => `user ${user}`;
const NEW_PERSON = (username: string, group: string): AcmeIdentity => ({
  sub: `acme-${username}`,
  email: `${username}@acme.example`,
  email_verified: true,
  preferred_username: username,
  groups: [group],
});

/** Where each Acme ID sign-in of the scenario ended, and in which browser. */
const ends = new WeakMap<SynoikiaWorld, { url: URL; status: number; text: string; browser: Portal }[]>();
const endsOf = (world: SynoikiaWorld) => {
  let e = ends.get(world);
  if (!e) ends.set(world, (e = []));
  return e;
};

/** `who` signs in at Acme ID from the sign-in page of the portal, in a fresh browser. */
async function ssoSignIn(world: SynoikiaWorld, who: AcmeIdentity, returnTo?: string) {
  (await world.acmeId()).next = who;
  const browser = await newPortal(world);
  const start =
    returnTo === undefined ? '/auth/oidc/start' : `/auth/oidc/start?returnTo=${encodeURIComponent(returnTo)}`;
  const end = await world.follow(browser, start, (at) => at.hostname === 'attacker.example');
  endsOf(world).push({ url: end.url, status: end.status, text: end.html, browser });
  return end;
}

const lastEnd = (world: SynoikiaWorld) => {
  const end = endsOf(world).at(-1);
  if (!end) throw new Error('nobody signed in with Acme ID yet');
  return end;
};

async function landsInPortal(world: SynoikiaWorld, end: ReturnType<typeof lastEnd>, username: string, path = '/') {
  expect(end.url.href).toBe(new URL(path, world.adminBase).href);
  const session = await world.expectOk(end.browser.get('/api/session'), 'read session');
  expect(session).toMatchObject({ authenticated: true, user: { username } });
  return session.user as { role: { name: string } };
}

async function setPolicy(world: SynoikiaWorld, policy: Record<string, unknown>) {
  await world.setUpAcmeId({ allowPolicy: { emails: [], subjects: [], group: '', ...policy } });
}

/** The consent page sends `person`'s browser to Acme ID; it comes back to core's callback, which is not opened yet. */
async function consentCallback(world: SynoikiaWorld) {
  const consent = identity(world).consent ?? (await consentPage(world));
  (await world.acmeId()).next = world.acmeIdentityOf(person(12));
  const end = await world.follow(
    consent.browser,
    `/oauth/login/oidc?continue=${encodeURIComponent(consent.path)}`,
    (at) => at.pathname === '/oauth/oidc/callback',
  );
  return { browser: consent.browser, callback: end.url.pathname + end.url.search };
}

const flip = (token: string) => {
  const i = token.lastIndexOf('.') + 2;
  return token.slice(0, i) + (token[i] === 'A' ? 'B' : 'A') + token.slice(i + 1);
};

const seen = new WeakMap<SynoikiaWorld, string[]>();

// ── setting up Acme ID ──

Given('the admin set up single sign-on with Acme ID', async (world: SynoikiaWorld) => {
  await world.setUpAcmeId();
});

Given('the admin turned single sign-on off', async (world: SynoikiaWorld) => {
  await world.setUpAcmeId({ enabled: false });
});

const ssoSave = new WeakMap<SynoikiaWorld, { status: number; body: Record<string, unknown> }>();

const saveSso = async (world: SynoikiaWorld, enabled: boolean) => {
  const res = await world.admin.put('/api/settings/oidc', { enabled, issuer: '', clientId: '' });
  ssoSave.set(world, { status: res.status, body: (await res.json()) as Record<string, unknown> });
};

When('the admin saves single sign-on as off, with no issuer and no client', async (world: SynoikiaWorld) => {
  await saveSso(world, false);
});

When('the admin tries to turn single sign-on on, with no issuer and no client', async (world: SynoikiaWorld) => {
  await saveSso(world, true);
});

const ssoSettings = async (world: SynoikiaWorld) =>
  ((await world.expectOk(world.admin.get('/api/settings'), 'read settings')) as { oidc: Record<string, unknown> }).oidc;

Then('single sign-on is off on the server, with no issuer and no client', async (world: SynoikiaWorld) => {
  expect(ssoSave.get(world)).toMatchObject({ status: 200, body: { enabled: false, issuer: '', clientId: '' } });
  expect(await ssoSettings(world)).toMatchObject({ enabled: false, issuer: '', clientId: '' });
});

Then(
  'the admin is told that the issuer and the client are not valid, and single sign-on stays as it was',
  async (world: SynoikiaWorld) => {
    const acme = await world.acmeId();
    expect(ssoSave.get(world)).toMatchObject({ status: 400, body: { error: 'invalid_oidc' } });
    const details = ssoSave.get(world)!.body.details as string[];
    expect(details.map((d) => d.split(':')[0]).sort()).toEqual(['clientId', 'issuer']);
    expect(await ssoSettings(world)).toMatchObject({ enabled: true, issuer: acme.issuer, clientId: acme.clientId });
  },
);

Given('the admin allows only the Acme ID group {string}', async (world: SynoikiaWorld, group: string) => {
  await setPolicy(world, { group });
});

Given('the admin allows only the address {string}', async (world: SynoikiaWorld, email: string) => {
  await setPolicy(world, { emails: [email] });
});

Given('the admin allows only {string} and {string}', async (world: SynoikiaWorld, a: string, b: string) => {
  await setPolicy(world, { emails: [a, b] });
});

Given('the admin allows only {string}', async (world: SynoikiaWorld, entry: string) => {
  await setPolicy(world, { emails: [entry] });
});

When(
  'the admin tries to allow {string}, {string} and {string}',
  async (world: SynoikiaWorld, a: string, b: string, c: string) => {
    const acme = await world.acmeId();
    const answers: string[] = [];
    for (const entry of [a, b, c]) {
      const res = await world.admin.put('/api/settings/oidc', {
        allowPolicy: { emails: [entry], subjects: [], group: '' },
        issuer: acme.issuer,
        clientId: acme.clientId,
      });
      answers.push(`${res.status} ${((await res.json()) as { error?: string }).error}`);
    }
    seen.set(world, answers);
  },
);

Then('the admin is told each time that the entry is not valid', (world: SynoikiaWorld) => {
  expect(seen.get(world)).toEqual(['400 invalid_oidc', '400 invalid_oidc', '400 invalid_oidc']);
});

When('the admin turns on automatic users with an empty allow policy', async (world: SynoikiaWorld) => {
  await keep(
    world,
    world.admin.put('/api/settings/oidc', {
      autoProvision: true,
      allowPolicy: { emails: [], subjects: [], group: '' },
    }),
  );
});

Then('the admin is told {string}', (world: SynoikiaWorld, message: string) => {
  const { answer } = identity(world);
  expect(answer.status).toBeGreaterThanOrEqual(400);
  expect(answer.text).toContain(message);
});

Given(
  'the admin turns on automatic users for the Acme ID group {string}',
  async (world: SynoikiaWorld, group: string) => {
    await world.setUpAcmeId({ autoProvision: true, allowPolicy: { emails: [], subjects: [], group } });
  },
);

Given('the default role for new users is {string}', async (world: SynoikiaWorld, role: string) => {
  const defaultRoleId = await world.role(role);
  await world.expectOk(world.admin.put('/api/settings/security', { defaultRoleId }), 'set the default role');
});

Given('the admin made the user {string}', async (world: SynoikiaWorld, username: string) => {
  await world.expectOk(
    world.admin.post('/api/users', {
      username,
      password: `${username} passphrase`,
      roleId: await world.role('family'),
    }),
    'create user',
  );
});

Given('Acme ID refuses every code with {string}', async (world: SynoikiaWorld, reason: string) => {
  (await world.acmeId()).refuse = reason;
});

Given(
  'Acme ID gives an identity token that expired {int} minutes ago',
  async (world: SynoikiaWorld, minutes: number) => {
    (await world.acmeId()).expiredForS = minutes * 60;
  },
);

// ── signing in with Acme ID ──

When('user {int} signs in with Acme ID', async (world: SynoikiaWorld, user: number) => {
  await ssoSignIn(world, world.acmeIdentityOf(person(user)));
});

When(
  'user {int} signs in with Acme ID, which says that the address is not verified',
  async (world: SynoikiaWorld, user: number) => {
    await ssoSignIn(world, { ...world.acmeIdentityOf(person(user)), email_verified: false });
  },
);

When(
  'user {int} signs in with Acme ID, which says nothing about the verification of the address',
  async (world: SynoikiaWorld, user: number) => {
    const { email_verified: _verified, ...who } = world.acmeIdentityOf(person(user));
    await ssoSignIn(world, who);
  },
);

When(
  'user {int} signs in with Acme ID as {string} and then as {string}',
  async (world: SynoikiaWorld, user: number, a: string, b: string) => {
    for (const email of [a, b]) await ssoSignIn(world, { ...world.acmeIdentityOf(person(user)), email });
  },
);

When(
  'user {int} signs in with Acme ID as {string}, {string} and {string}',
  async (world: SynoikiaWorld, user: number, a: string, b: string, c: string) => {
    for (const email of [a, b, c]) await ssoSignIn(world, { ...world.acmeIdentityOf(person(user)), email });
  },
);

When('someone signs in with the Acme ID {string} that no account has', async (world: SynoikiaWorld, sub: string) => {
  await ssoSignIn(world, { sub, email: 'stranger@acme.example', email_verified: true, groups: [] });
});

When(
  '{string} signs in with Acme ID in the group {string}',
  async (world: SynoikiaWorld, username: string, group: string) => {
    await ssoSignIn(world, NEW_PERSON(username, group));
  },
);

Given(
  '{string} signed in with Acme ID in the group {string}',
  async (world: SynoikiaWorld, username: string, group: string) => {
    await ssoSignIn(world, NEW_PERSON(username, group));
    await landsInPortal(world, lastEnd(world), username);
  },
);

Then('user {int} is told that single sign-on is not enabled', (world: SynoikiaWorld, _user: number) => {
  const end = lastEnd(world);
  expect(end.status).toBe(400);
  expect(end.text).toContain('OIDC sign-in is not enabled');
});

Then('user {int} lands in the portal', async (world: SynoikiaWorld, user: number) => {
  await landsInPortal(world, lastEnd(world), world.person(person(user)).username);
});

When(
  'user {int} signs in with Acme ID from the page {string}',
  async (world: SynoikiaWorld, user: number, page: string) => {
    await ssoSignIn(world, world.acmeIdentityOf(person(user)), page);
  },
);

When(
  'user {int} signs in with Acme ID from links that return to {string} and to a tab and {string}',
  async (world: SynoikiaWorld, user: number, a: string, b: string) => {
    for (const returnTo of [a, `/\t${b}`]) await ssoSignIn(world, world.acmeIdentityOf(person(user)), returnTo);
  },
);

Then('user {int} lands on {string}', async (world: SynoikiaWorld, user: number, page: string) => {
  await landsInPortal(world, lastEnd(world), world.person(person(user)).username, page);
});

Then('user {int} lands on the portal home both times', async (world: SynoikiaWorld, user: number) => {
  const all = endsOf(world);
  expect(all).toHaveLength(2);
  for (const end of all) await landsInPortal(world, end, world.person(person(user)).username);
});

Then('user {int} lands in the portal both times', async (world: SynoikiaWorld, user: number) => {
  const all = endsOf(world);
  expect(all).toHaveLength(2);
  for (const end of all) await landsInPortal(world, end, world.person(person(user)).username);
});

Then(
  '{string} lands in the portal with the role {string}',
  async (world: SynoikiaWorld, username: string, role: string) => {
    const user = await landsInPortal(world, lastEnd(world), username);
    expect(user.role.name).toBe(role);
  },
);

Then('the sign-in with Acme ID fails, and user {int} is not signed in', async (world: SynoikiaWorld) => {
  const end = lastEnd(world);
  expect(end.url.pathname + end.url.search).toBe('/login?error=oidc_failed');
  expect(await world.expectOk(end.browser.get('/api/session'), 'read session')).toMatchObject({
    authenticated: false,
  });
  const [failure] = await world.audit({ kind: 'auth', decision: 'oidc_failed' });
  expect(failure?.detail).toEqual({ error: 'Sign-in failed: JWT timestamp claim value failed validation' });
});

Then('the sign-in with Acme ID is refused as not allowed', (world: SynoikiaWorld) => {
  expect(lastEnd(world).url.pathname + lastEnd(world).url.search).toBe('/login?error=oidc_not_allowed');
});

Then('the sign-in with Acme ID is refused as not allowed each time', (world: SynoikiaWorld) => {
  const all = endsOf(world).map((e) => e.url.pathname + e.url.search);
  expect(all).toEqual(Array(3).fill('/login?error=oidc_not_allowed'));
});

Then('the audit log shows the refused sign-in of the Acme ID {string}', async (world: SynoikiaWorld, sub: string) => {
  const rows = await world.audit({ kind: 'auth', decision: 'oidc_denied' });
  expect(rows.map((r) => r.detail?.subject)).toEqual([sub]);
});

// ── tampered sign-ins on the consent page ──

When(
  'user {int} comes back from Acme ID to the consent page with a forged state, and then with a state 11 minutes old',
  async (world: SynoikiaWorld, _user: number) => {
    const pages: string[] = [];
    const forged = await consentCallback(world);
    forged.browser.jar.set('syn_mcp_oidc', flip(forged.browser.jar.get('syn_mcp_oidc')!));
    pages.push((await forged.browser.send(forged.callback)).html);
    const old = await consentCallback(world);
    world.passTime(11 * 60_000);
    pages.push((await old.browser.send(old.callback)).html);
    seen.set(world, pages);
  },
);

When(
  'user {int} comes back from Acme ID to the consent page with the proof of their code step as the state',
  async (world: SynoikiaWorld, user: number) => {
    const codeStep = await consentSignIn(world, person(user));
    const proof = /name="mfa" value="([^"]+)"/.exec(codeStep.html)?.[1];
    if (!proof) throw new Error(`no code step: ${codeStep.html}`);
    const back = await consentCallback(world);
    back.browser.jar.set('syn_mcp_oidc', proof);
    seen.set(world, [(await back.browser.send(back.callback)).html]);
  },
);

When('user {int} signs in with Acme ID on the consent page', async (world: SynoikiaWorld, _user: number) => {
  const back = await consentCallback(world);
  seen.set(world, [(await back.browser.send(back.callback)).html]);
});

Then('user {int} is told both times that the sign-in expired or is invalid', (world: SynoikiaWorld, _user: number) => {
  const pages = seen.get(world)!;
  expect(pages).toHaveLength(2);
  for (const html of pages) expect(html).toContain('Sign-in session expired or invalid');
});

Then('user {int} is told that the sign-in expired or is invalid', (world: SynoikiaWorld, _user: number) => {
  expect(seen.get(world)![0]).toContain('Sign-in session expired or invalid');
});

Then('user {int} sees {string}', (world: SynoikiaWorld, _user: number, text: string) => {
  expect(seen.get(world)![0]).toContain(text);
});

// ── local and SSO accounts (ADR-0025) ──

const firstAccount = new WeakMap<SynoikiaWorld, string>();
const sessionUser = async (end: ReturnType<typeof lastEnd>) =>
  ((await (await end.browser.get('/api/session')).json()) as { user?: { id: string; username: string } }).user;

Given(
  'user {int} has an SSO account with the role {string}',
  async (world: SynoikiaWorld, user: number, role: string) => {
    await world.ssoUser(person(user), role);
  },
);

Given(
  'user {int} has a local account with the role {string}',
  async (world: SynoikiaWorld, user: number, role: string) => {
    await world.user(person(user), role);
  },
);

Given(
  'the admin made an SSO account for {string} with the role {string}',
  async (world: SynoikiaWorld, email: string, role: string) => {
    const roleId = await world.role(role);
    await world.expectOk(
      world.admin.post('/api/users', { username: email, kind: 'sso', oidcEmail: email, roleId }),
      'create SSO account',
    );
  },
);

When('user {int} signs in with Acme ID as {string}', async (world: SynoikiaWorld, user: number, email: string) => {
  await ssoSignIn(world, { ...world.acmeIdentityOf(person(user)), email });
});

Given(
  'user {int} signed in once with Acme ID as {string}',
  async (world: SynoikiaWorld, user: number, email: string) => {
    await ssoSignIn(world, { ...world.acmeIdentityOf(person(user)), email });
    await landsInPortal(world, lastEnd(world), email);
    firstAccount.set(world, (await sessionUser(lastEnd(world)))!.id);
  },
);

Then(
  'user {int} lands in the portal with the role {string}',
  async (world: SynoikiaWorld, user: number, role: string) => {
    const signedIn = await landsInPortal(world, lastEnd(world), `${person(user).replace(/\s+/g, '')}@acme.example`);
    expect(signedIn.role.name).toBe(role);
  },
);

Then('user {int} lands in the same account', async (world: SynoikiaWorld, _user: number) => {
  expect(lastEnd(world).url.pathname).toBe('/');
  expect((await sessionUser(lastEnd(world)))?.id).toBe(firstAccount.get(world));
});

When('someone signs in with Acme ID as {string}', async (world: SynoikiaWorld, email: string) => {
  await ssoSignIn(world, { sub: 'acme-someone', email, email_verified: true, groups: [] });
});

Then('the sign-in with Acme ID is refused as not allowed, and nobody is signed in', async (world: SynoikiaWorld) => {
  expect(lastEnd(world).url.pathname + lastEnd(world).url.search).toBe('/login?error=oidc_not_allowed');
  expect(await sessionUser(lastEnd(world))).toBeUndefined();
});

Then('user {int} lands in the portal without setting up an app', async (world: SynoikiaWorld, user: number) => {
  await landsInPortal(world, lastEnd(world), world.person(person(user)).username);
  const session = await world.expectOk(lastEnd(world).browser.get('/api/session'), 'read session');
  expect(session).toMatchObject({ mustEnrollTotp: false });
});

Given('the admin set up single sign-on with Acme ID, and user 21 has an SSO account', async (world: SynoikiaWorld) => {
  await world.setUpAcmeId();
  await world.ssoUser(person(21), 'family');
});
