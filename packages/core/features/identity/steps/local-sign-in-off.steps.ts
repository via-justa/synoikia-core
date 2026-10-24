import { Given, Then, When } from 'quickpickle';
import { expect } from 'vitest';
import type { SynoikiaWorld } from '../../support/world.js';
import { consentPage, identity, keep, passwordStep } from './identity.js';

const LOCKED_OUT = 'Local login is disabled, so this would lock everyone out.';

const passwordSignIn = (world: SynoikiaWorld, on: boolean) =>
  world.admin.put('/api/settings/security', { disableLocalLogin: !on });

const refusals = new WeakMap<SynoikiaWorld, { status: number; message: string }[]>();

When('the admin turns off password sign-in', async (world: SynoikiaWorld) => {
  await keep(world, passwordSignIn(world, false));
});

Given('password sign-in is off', async (world: SynoikiaWorld) => {
  await world.expectOk(passwordSignIn(world, false), 'turn off password sign-in');
});

Given('password sign-in was off, and the admin turned it on again', async (world: SynoikiaWorld) => {
  await world.expectOk(passwordSignIn(world, false), 'turn off password sign-in');
  await world.expectOk(passwordSignIn(world, true), 'turn on password sign-in');
});

Then(
  'a sign-in with a password is told {string} in the portal and on the consent page, which offers only Acme ID',
  async (world: SynoikiaWorld, message: string) => {
    expect(identity(world).answer.status).toBe(200);
    await passwordStep(world, 'admin');
    expect(identity(world).answer).toMatchObject({ status: 403, body: { message } });
    const { browser, path, page } = await consentPage(world);
    expect(page!.html).not.toContain('name="password"');
    expect(page!.html).toContain('Acme ID');
    const { username, password } = world.person('admin');
    const csrf = browser.jar.get('syn_mcp_csrf')!;
    const posted = await browser.send('/oauth/login', { csrf, continue: path, username, password });
    expect(posted.status).toBe(401);
    expect(posted.html).toContain(`${message}.`);
  },
);

When('the admin tries each change that would leave no SSO account that signs in', async (world: SynoikiaWorld) => {
  const who = world.person('user 12');
  const tries = [
    () => world.admin.patch(`/api/users/${who.id}`, { disabled: true }),
    () => world.admin.del(`/api/users/${who.id}`),
    () => world.admin.put('/api/settings/oidc', { enabled: false }),
  ];
  const seen: { status: number; message: string }[] = [];
  for (const send of tries) {
    const r = await send();
    seen.push({ status: r.status, message: ((await r.json()) as { message: string }).message });
  }
  refusals.set(world, seen);
});

Then('each change is refused, because password sign-in is off', async (world: SynoikiaWorld) => {
  const seen = refusals.get(world)!;
  expect(seen).toHaveLength(3);
  for (const r of seen) expect(r).toEqual({ status: 409, message: expect.stringContaining(LOCKED_OUT) as string });
  const me = await world.expectOk(world.person('user 12').portal!.get('/api/profile'), 'read profile');
  expect(me).toMatchObject({ kind: 'sso', oidcLinked: true, disabled: false });
});

Then('the admin sees that user {int} is disabled', async (world: SynoikiaWorld, user: number) => {
  const users = (await world.expectOk(world.admin.get('/api/users'), 'list users')) as unknown as {
    id: string;
    disabled: boolean;
  }[];
  expect(users.find((u) => u.id === world.person(`user ${user}`).id)?.disabled).toBe(true);
});

When('the operator restarts the server with password sign-in forced on', async (world: SynoikiaWorld) => {
  await world.restartCore({ ADMIN_FORCE_LOCAL_LOGIN: 'true' });
});

Then('the admin can sign in to the portal with a password', async (world: SynoikiaWorld) => {
  await passwordStep(world, 'admin');
  expect(identity(world).answer.body).toMatchObject({ status: 'ok' });
});
