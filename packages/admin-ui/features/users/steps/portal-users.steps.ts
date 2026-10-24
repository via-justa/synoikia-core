import { randomUUID } from 'node:crypto';
import type { Locator } from 'playwright';
import { Given, Then, When } from 'quickpickle';
import { expect } from 'vitest';
import { openDatabase } from '../../../../core/src/db/index.js';
import type { PortalWorld } from '../../support/world.js';

const seen = (locator: Locator) => locator.waitFor({ state: 'visible', timeout: 10_000 });
const usersTable = (world: PortalWorld) => world.page.getByRole('table', { name: 'Users' });
const dialog = (world: PortalWorld) => world.page.getByRole('dialog');

/** The row of a person on the user list. */
const row = (world: PortalWorld, name: string) =>
  usersTable(world)
    .getByRole('row')
    .filter({ has: world.page.getByRole('cell', { name: new RegExp(`^${world.person(name).username}\\b`) }) });

/** The account of a person as core keeps it. */
async function account(world: PortalWorld, name: string) {
  const users = (await world.expectOk((await world.adminApi()).get('/api/users'), 'users')) as unknown as {
    username: string;
    disabled: boolean;
    totpEnabled: boolean;
  }[];
  return users.find((u) => u.username === world.person(name).username);
}

export async function userList(world: PortalWorld) {
  await world.openAsAdmin('/settings/users');
  await seen(row(world, 'admin').or(world.page.getByRole('alert')).first());
}

// ── setup ──

Given('the server cannot read its users', (world: PortalWorld) => {
  // A stored user whose recovery codes are not JSON: core fails on the list, but not on the admin's own account.
  const db = openDatabase({ dataDir: world.dataDir });
  try {
    db.$client
      .prepare('INSERT INTO users (id, username, created_at, recovery_codes_hash) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), 'unreadable@acme.example', Date.now(), '{not json');
  } finally {
    db.$client.close();
  }
});

Given(
  'user {int} has the role {string} and an authenticator app',
  async (world: PortalWorld, n: number, role: string) => {
    await world.user(`user ${n}`, { name: role });
    await world.authenticatorApp(`user ${n}`);
  },
);

When('the admin opens the user list', async (world: PortalWorld) => {
  await userList(world);
});

Then('the portal shows why the user list did not load', async (world: PortalWorld) => {
  await seen(world.page.getByRole('alert'));
  expect((await world.page.getByRole('alert').textContent())?.trim()).not.toBe('');
  expect(await usersTable(world).locator('tbody tr').count()).toBe(0);
});

// ── roles ──

When(
  'the admin picks the role {string} for user {int} on the user list',
  async (world: PortalWorld, role: string, n: number) => {
    await world.role(role);
    await userList(world);
    const saved = world.page.waitForResponse((r) => r.request().method() === 'PATCH');
    await row(world, `user ${n}`).getByRole('combobox').selectOption({ label: role });
    await saved;
  },
);

Then(
  'the roles page shows {int} user in {string} and {int} users in {string}',
  async (world: PortalWorld, one: number, first: string, none: number, second: string) => {
    await world.page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('link', { name: 'Roles' })
      .click();
    const count = (role: string) => world.page.locator(`[data-role="${role}"]`).getByText(/^\d+ users?$/);
    await expect.poll(() => count(first).textContent()).toBe(`${one} user`);
    await expect.poll(() => count(second).textContent()).toBe(`${none} users`);
  },
);

When('the admin picks the role {string} for themselves on the user list', async (world: PortalWorld, role: string) => {
  await world.role(role);
  await userList(world);
  await row(world, 'admin').getByRole('combobox').selectOption({ label: role });
});

// ── row actions ──

When(
  'the admin disables user {int} on the user list and confirms the question',
  async (world: PortalWorld, n: number) => {
    await userList(world);
    await row(world, `user ${n}`).getByRole('button', { name: 'Disable' }).click();
    await world.answerQuestion('Disable');
  },
);

Then('user {int} shows as disabled', async (world: PortalWorld, n: number) => {
  await seen(row(world, `user ${n}`).getByText('disabled', { exact: true }));
  expect((await account(world, `user ${n}`))?.disabled).toBe(true);
});

When(
  'the admin starts to reset two-factor for user {int} and cancels the question',
  async (world: PortalWorld, n: number) => {
    await userList(world);
    await row(world, `user ${n}`).getByRole('button', { name: 'Reset 2FA' }).click();
    await world.answerQuestion('Cancel');
    await expect.poll(() => dialog(world).count()).toBe(0);
  },
);

Then('the focus is back on the two-factor reset of user {int}', async (world: PortalWorld, n: number) => {
  const focused = () =>
    world.page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return `${el?.textContent?.trim()} · ${el?.closest('tr')?.textContent ?? ''}`;
    });
  await expect.poll(focused).toMatch(new RegExp(`^Reset 2FA · .*${world.person(`user ${n}`).username}`));
});

Then('user {int} still has two-factor sign-in', async (world: PortalWorld, n: number) => {
  expect((await account(world, `user ${n}`))?.totpEnabled).toBe(true);
});

When(
  'the admin sets the password {string} for user {int} on the user list',
  async (world: PortalWorld, password: string, n: number) => {
    await userList(world);
    await row(world, `user ${n}`).getByRole('button', { name: 'Set password' }).click();
    const set = dialog(world).getByRole('button', { name: 'Set password' });
    await dialog(world).getByLabel('New password').fill(password.slice(0, 11));
    world.noted.shortRefused = String(await set.isDisabled());
    await dialog(world).getByLabel('New password').fill(password);
    await set.click();
    await expect.poll(() => dialog(world).count()).toBe(0);
  },
);

Then('the dialog took no password shorter than 12 characters', (world: PortalWorld) => {
  expect(world.noted.shortRefused).toBe('true');
});

Then('user {int} can sign in with {string}', async (world: PortalWorld, n: number, password: string) => {
  const who = world.person(`user ${n}`);
  who.password = password;
  await world.apiAs(`user ${n}`);
});

// ── adding and deleting ──

When('the admin adds a user with the name of user {int}', async (world: PortalWorld, n: number) => {
  await userList(world);
  await world.page.getByRole('button', { name: 'Add user' }).click();
  await dialog(world)
    .getByLabel('Username')
    .fill(world.person(`user ${n}`).username);
  await dialog(world).getByLabel('Password').fill('another world passphrase');
  await dialog(world).getByRole('button', { name: 'Add', exact: true }).click();
});

Then('the add dialog shows the alert {string}', async (world: PortalWorld, text: string) => {
  await seen(dialog(world).getByRole('alert').filter({ hasText: text }));
});

Then('the next add dialog starts empty', async (world: PortalWorld) => {
  await dialog(world).getByRole('button', { name: 'Cancel' }).click();
  await world.page.getByRole('button', { name: 'Add user' }).click();
  expect(await dialog(world).getByLabel('Username').inputValue()).toBe('');
  expect(await dialog(world).getByLabel('Password').inputValue()).toBe('');
  expect(await dialog(world).getByRole('alert').count()).toBe(0);
});

When(
  'the admin deletes user {int} on the user list, typing their name in the question',
  async (world: PortalWorld, n: number) => {
    const name = world.person(`user ${n}`).username;
    await userList(world);
    await row(world, `user ${n}`).getByRole('button', { name: 'Delete' }).click();
    const remove = dialog(world).getByRole('button', { name: 'Delete', exact: true });
    const states: boolean[] = [];
    for (const typed of ['', name.slice(0, -1), name.toUpperCase()]) {
      await dialog(world).getByRole('textbox').fill(typed);
      states.push(await remove.isDisabled());
    }
    world.noted.unavailable = String(states.every(Boolean));
    await dialog(world).getByRole('textbox').fill(name);
    await remove.click();
  },
);

Then('the delete was unavailable until the name was exact', (world: PortalWorld) => {
  expect(world.noted.unavailable).toBe('true');
});

Then('user {int} is gone from the user list', async (world: PortalWorld, n: number) => {
  await expect.poll(() => row(world, `user ${n}`).count()).toBe(0);
  expect(await account(world, `user ${n}`)).toBeUndefined();
});

Then('the row of the admin offers no delete and no disable', async (world: PortalWorld) => {
  const own = row(world, 'admin');
  await seen(own.getByRole('button', { name: 'Set password' }));
  expect(await own.getByRole('button', { name: /^(Delete|Disable)$/ }).count()).toBe(0);
});

// ── an SSO account (ADR-0025) ──

Then(
  'the row of user {int} shows {string} and offers no {string}',
  async (world: PortalWorld, n: number, pill: string, action: string) => {
    const user = row(world, `user ${n}`);
    await seen(user.getByText(pill, { exact: true }));
    expect(await user.getByRole('button', { name: action }).count()).toBe(0);
  },
);
