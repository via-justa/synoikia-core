import type { Locator } from 'playwright';
import { Given, Then, When } from 'quickpickle';
import { expect } from 'vitest';
import { totpCode } from '../../support/world.js';
import type { PortalWorld } from '../../support/world.js';

const seen = (locator: Locator) => locator.waitFor({ state: 'visible', timeout: 10_000 });
const passwordOf = (world: PortalWorld) => world.page.getByLabel('Password', { exact: true });
const signInAction = (world: PortalWorld) => world.page.getByRole('button', { name: 'Sign in', exact: true });
/** The app's one polite live region: what a screen reader says without interrupting. */
const spoken = (world: PortalWorld) => world.page.locator('[aria-live="polite"]');

async function seesAuditLog(world: PortalWorld) {
  await seen(world.page.getByRole('heading', { name: 'Audit Log' }));
  expect(new URL(world.page.url()).pathname).toBe('/audit');
}

async function signInPage(world: PortalWorld) {
  await world.open('/login');
  await seen(world.page.getByLabel('Username'));
}

// ── signing in ──

When('the admin opens the audit log while signed out', async (world: PortalWorld) => {
  await world.open('/audit');
});

Then('the portal asks the admin to sign in', async (world: PortalWorld) => {
  await seen(world.page.getByLabel('Username'));
  await seen(passwordOf(world));
});

Then('after the sign-in with their password, the admin sees the audit log', async (world: PortalWorld) => {
  await world.signIn('admin');
  await seesAuditLog(world);
});

When('a visitor gives only the name {string} on the sign-in page', async (world: PortalWorld, name: string) => {
  await signInPage(world);
  await world.page.getByLabel('Username').fill(name);
});

Then('the visitor cannot sign in yet', async (world: PortalWorld) => {
  expect(await signInAction(world).isDisabled()).toBe(true);
  await passwordOf(world).fill('world admin passphrase');
  expect(await signInAction(world).isEnabled()).toBe(true);
});

When('the admin signs in with the password {string}', async (world: PortalWorld, password: string) => {
  await signInPage(world);
  await world.signIn('admin', password);
});

Then('the portal says {string}', async (world: PortalWorld, text: string) => {
  await seen(world.page.getByText(text).first());
});

Then('the password is empty again', async (world: PortalWorld) => {
  await expect.poll(() => passwordOf(world).inputValue()).toBe('');
});

// ── two-factor sign-in ──

Given('the admin has an authenticator app', async (world: PortalWorld) => {
  await world.authenticatorApp('admin');
});

When('the admin opens the audit log and gives their password', async (world: PortalWorld) => {
  await world.open('/audit');
  await seen(world.page.getByLabel('Username'));
  await world.signIn('admin');
});

Then('the portal asks for the code from the authenticator app', async (world: PortalWorld) => {
  await seen(world.page.getByLabel('Two-factor code'));
});

Then('after the current code, the admin sees the audit log', async (world: PortalWorld) => {
  await world.page.getByLabel('Two-factor code').fill(totpCode(world.person('admin').totpSecret!));
  await world.page.getByRole('button', { name: 'Verify' }).click();
  await seesAuditLog(world);
});

// ── single sign-on ──

Given('the admin set up single sign-on with {string}', async (world: PortalWorld, label: string) => {
  await world.singleSignOn(label);
});

Given('user 12 has an SSO account, and the admin turned off the password sign-in', async (world: PortalWorld) => {
  await world.ssoUser('user 12', { name: 'family' });
  const admin = await world.adminApi();
  await world.expectOk(admin.put('/api/settings/security', { disableLocalLogin: true }), 'turn off password sign-in');
});

When('a visitor opens the sign-in page', async (world: PortalWorld) => {
  await world.open('/login');
  await seen(world.page.getByRole('heading', { level: 1 }));
});

Then('the visitor is offered {string}', async (world: PortalWorld, name: string) => {
  await seen(world.page.getByRole('link', { name }));
});

Then('the visitor is not asked for a password', async (world: PortalWorld) => {
  expect(await passwordOf(world).count()).toBe(0);
  expect(await signInAction(world).count()).toBe(0);
});

// ── where the portal holds people ──

Given('a new server with no accounts', async (world: PortalWorld) => {
  await world.freshCore();
});

When('a visitor opens the plugins page', async (world: PortalWorld) => {
  await world.open('/plugins');
});

Then('the visitor sees {string}', async (world: PortalWorld, text: string) => {
  await seen(world.page.getByText(text));
});

Given('user {int} has the role {string}', async (world: PortalWorld, user: number, role: string) => {
  await world.user(`user ${user}`, { name: role });
});

Given('the admin requires two-factor sign-in for everyone', async (world: PortalWorld) => {
  const admin = await world.adminApi();
  await world.expectOk(admin.put('/api/settings/security', { requireTotp: true }), 'require two-factor sign-in');
});

When('user {int} signs in with their password', async (world: PortalWorld, user: number) => {
  await signInPage(world);
  await world.signIn(`user ${user}`);
});

Given('the admin lets people sign up with the role {string}', async (world: PortalWorld, role: string) => {
  const defaultRoleId = await world.role(role);
  const admin = await world.adminApi();
  await world.expectOk(admin.put('/api/settings/security', { defaultRoleId, localSignup: true }), 'open sign-up');
});

Given('the admin has not opened sign-up', () => {});

Then('the visitor can create an account', async (world: PortalWorld) => {
  await seen(world.page.getByRole('button', { name: 'Create account' }));
});

Then('the visitor cannot create an account', async (world: PortalWorld) => {
  await seen(signInAction(world));
  expect(await world.page.getByRole('button', { name: 'Create account' }).count()).toBe(0);
});

// ── the next person in the same browser ──

Given('{string} is an admin who never signed in', async (world: PortalWorld, name: string) => {
  await world.user(name, { id: 'admin' });
});

Given('the admin saw the user list in the portal and signed out', async (world: PortalWorld) => {
  await world.open('/settings/users');
  await seen(world.page.getByLabel('Username'));
  await world.signIn('admin');
  await seen(userRow(world, 'root').getByRole('cell', { name: 'never' }));
  await world.page.getByRole('button', { name: 'Log out' }).click();
  await seen(world.page.getByLabel('Username'));
});

const userRow = (world: PortalWorld, name: string) =>
  world.page
    .getByRole('table', { name: 'Users' })
    .getByRole('row')
    .filter({ has: world.page.getByRole('cell', { name: new RegExp(`^${name}\\b`) }) });

When('{string} signs in in the same browser and opens the user list', async (world: PortalWorld, name: string) => {
  await world.signIn(name);
  await world.page.getByRole('link', { name: 'Settings', exact: true }).click();
  await world.page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Users' }).click();
});

Then('the user list shows that {string} signed in just now', async (world: PortalWorld, name: string) => {
  await seen(userRow(world, name).getByRole('cell', { name: 'just now' }));
});

// ── setup ──

When('the admin types the password {string} on the setup page', async (world: PortalWorld, password: string) => {
  await world.open('/setup');
  await passwordOf(world).fill(password);
});

Then(
  'the setup page shows {string} and a screen reader hears nothing yet',
  async (world: PortalWorld, text: string) => {
    await seen(world.page.getByText(text));
    expect(await world.page.getByRole('alert').count()).toBe(0);
    expect(await spoken(world).textContent()).toBe('');
  },
);

Then('a screen reader hears {string} once the admin leaves the password', async (world: PortalWorld, text: string) => {
  await passwordOf(world).blur();
  await expect.poll(() => spoken(world).textContent()).toBe(text);
});

Given(
  'the admin opened the setup page, and someone else made the first account meanwhile',
  async (world: PortalWorld) => {
    await world.open('/setup');
    await seen(world.page.getByRole('heading', { name: 'Create the first admin account' }));
    const other = await world.apiSession();
    await world.expectOk(
      other.post('/api/setup', { username: 'operator', password: 'operator world passphrase' }),
      'make the first account',
    );
  },
);

When(
  'the admin makes the first account {string} with the password {string}',
  async (world: PortalWorld, name: string, password: string) => {
    await world.page.getByLabel('Username').fill(name);
    await passwordOf(world).fill(password);
    await world.page.getByLabel('Confirm password').fill(password);
    await world.page.getByRole('button', { name: 'Create account' }).click();
  },
);

Then('a screen reader hears the alert {string}', async (world: PortalWorld, text: string) => {
  await seen(world.page.getByRole('alert').filter({ hasText: text }));
});
