import type { Locator } from 'playwright';
import { Given, Then, When } from 'quickpickle';
import { expect } from 'vitest';
import { totpCode } from '../../support/world.js';
import type { PortalWorld } from '../../support/world.js';

const seen = (locator: Locator) => locator.waitFor({ state: 'visible', timeout: 10_000 });
const myTokens = (world: PortalWorld) => world.page.getByRole('table', { name: 'My tokens' });
const passwordCard = (world: PortalWorld) =>
  world.page.locator('section').filter({ has: world.page.getByRole('heading', { name: 'Password' }) });

export async function profile(world: PortalWorld) {
  await world.openAsAdmin('/profile');
  await seen(world.page.getByRole('heading', { name: 'My profile', level: 1 }));
  await seen(world.page.getByText('Signed in as'));
}

// ── an SSO account (ADR-0025) ──

Given('user 12 has an SSO account with the role {string}', async (world: PortalWorld, role: string) => {
  await world.ssoUser('user 12', { name: role });
});

When('user 12 opens their profile', async (world: PortalWorld) => {
  await world.openAs('user 12', '/profile');
  await seen(world.page.getByRole('heading', { name: 'My profile', level: 1 }));
  await seen(world.page.getByText('Signed in as'));
});

Then(
  'the profile shows no password and no two-factor setup, and says that user 12 signs in with {string}',
  async (world: PortalWorld, label: string) => {
    await seen(world.page.getByText(`You sign in with ${label}.`));
    expect(await world.page.getByRole('heading', { name: 'Password' }).count()).toBe(0);
    expect(await world.page.getByRole('heading', { name: 'Two-factor authentication' }).count()).toBe(0);
  },
);

Then('the profile says {string}', async (world: PortalWorld, text: string) => {
  await seen(world.page.getByText(text));
});

// ── own tokens ──

Given('the admin made their own token {string}', async (world: PortalWorld, name: string) => {
  await world.expectOk(
    (await world.adminApi()).post('/api/me/tokens', { name, scope: ['*'], access: 'read' }),
    'make an own token',
  );
});

When(
  'the admin revokes {string} on their profile and confirms the question',
  async (world: PortalWorld, name: string) => {
    await profile(world);
    await myTokens(world).getByRole('row').filter({ hasText: name }).getByRole('button', { name: 'Revoke' }).click();
    await world.answerQuestion('Revoke');
  },
);

Then('the profile no longer lists {string}', async (world: PortalWorld, name: string) => {
  await expect.poll(() => world.page.getByText(name, { exact: true }).count()).toBe(0);
  const mine = (await world.expectOk((await world.adminApi()).get('/api/me/tokens'), 'my tokens')) as unknown as {
    revokedAt: string | null;
  }[];
  expect(mine.every((t) => t.revokedAt)).toBe(true);
});

// ── two-factor ──

async function setUpTwoFactor(world: PortalWorld) {
  await profile(world);
  await world.page.getByRole('button', { name: 'Set up two-factor authentication' }).click();
  const secret = (await world.page.locator('code.secret').textContent()) ?? '';
  await world.page.getByRole('textbox', { name: 'Code' }).fill(totpCode(secret.trim()));
  await world.page.getByRole('button', { name: 'Confirm' }).click();
}

When('the admin sets up two-factor sign-in on their profile with the current code', async (world: PortalWorld) => {
  await setUpTwoFactor(world);
});

Given(
  'the admin set up two-factor sign-in on their profile and sees the recovery codes',
  async (world: PortalWorld) => {
    await setUpTwoFactor(world);
    await seen(world.page.locator('pre.recovery'));
    world.noted.reloads = '/api/profile';
  },
);

Then('the profile still shows the recovery codes', async (world: PortalWorld) => {
  await world.page.waitForTimeout(500);
  const codes = world.page.locator('pre.recovery');
  expect(await codes.count()).toBe(1);
  expect((await codes.textContent())?.trim().split('\n').length).toBeGreaterThan(1);
  await seen(world.page.getByRole('button', { name: 'I saved them' }));
});

Then('the profile shows the recovery codes until the admin says they saved them', async (world: PortalWorld) => {
  const codes = world.page.locator('pre.recovery');
  await seen(codes);
  expect((await codes.textContent())?.trim().split('\n').length).toBeGreaterThan(1);
  await world.page.getByRole('button', { name: 'I saved them' }).click();
  await expect.poll(() => codes.count()).toBe(0);
});

async function askForNewCodes(world: PortalWorld, code: (secret: string) => string) {
  await profile(world);
  await world.page.getByRole('button', { name: 'New recovery codes' }).click();
  const dialog = world.page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Code' }).fill(code(world.person('admin').totpSecret!));
  await dialog.getByRole('button', { name: 'Get new codes' }).click();
}

When('the admin asks for new recovery codes on their profile with the current code', async (world: PortalWorld) => {
  await askForNewCodes(world, (secret) => totpCode(secret));
});

When('the admin asks for new recovery codes on their profile with a wrong code', async (world: PortalWorld) => {
  await askForNewCodes(world, (secret) => {
    const valid = new Set([-1, 0, 1].map((s) => totpCode(secret, s)));
    let n = 123456;
    while (valid.has(String(n))) n++;
    return String(n);
  });
});

Then('the profile shows the new recovery codes until the admin says they saved them', async (world: PortalWorld) => {
  const codes = world.page.locator('pre.recovery');
  await seen(codes);
  expect((await codes.textContent())?.trim().split('\n')).toHaveLength(10);
  expect(await world.page.getByRole('dialog').count()).toBe(0);
  await world.page.getByRole('button', { name: 'I saved them' }).click();
  await expect.poll(() => codes.count()).toBe(0);
});

Then('the question says {string}', async (world: PortalWorld, text: string) => {
  await seen(world.page.getByRole('dialog').getByRole('alert').getByText(text));
});

// ── password ──

async function changePassword(world: PortalWorld, current: string, next: string, confirm: string) {
  await profile(world);
  await world.page.getByLabel('Current password').fill(current);
  await world.page.getByLabel('New password').fill(next);
  await world.page.getByLabel('Confirm', { exact: true }).fill(confirm);
  await passwordCard(world).getByRole('button', { name: 'Change password' }).click();
}

When('the admin changes their password with a confirmation that does not match', async (world: PortalWorld) => {
  await changePassword(world, world.person('admin').password, 'a new world passphrase', 'another world passphrase');
});

When(
  'the admin changes their password, giving {string} as the current one',
  async (world: PortalWorld, current: string) => {
    await changePassword(world, current, 'a new world passphrase', 'a new world passphrase');
  },
);

Then('the admin still signs in with their old password', async (world: PortalWorld) => {
  await world.apiAs('admin');
});

// ── theme ──

When(
  'the admin picks the theme {string} on their profile and reloads the portal',
  async (world: PortalWorld, theme: string) => {
    await profile(world);
    await world.page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: theme }).click();
    await world.page.reload();
    await seen(world.page.getByRole('radiogroup', { name: 'Theme' }));
  },
);

Then('the portal is dark, with {string} picked', async (world: PortalWorld, theme: string) => {
  expect(await world.page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  expect(
    await world.page
      .getByRole('radiogroup', { name: 'Theme' })
      .getByRole('radio', { name: theme })
      .getAttribute('aria-checked'),
  ).toBe('true');
});
