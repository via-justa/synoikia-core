import { Given, Then, When } from 'quickpickle';
import { expect } from 'vitest';
import type { SynoikiaWorld } from '../../support/world.js';

type Change = { path: string; before: unknown; after: unknown };

const unescape = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** The changes the approval page of the last parked call shows, and the whole page. */
const approvalPage = async (world: SynoikiaWorld) => {
  const { html } = await world.approvalPage('admin');
  const block = /<label>Changes<\/label>\s*<pre>([\s\S]*?)<\/pre>/.exec(html)?.[1];
  if (!block) throw new Error('The approval page shows no changes');
  return { html: unescape(html), changes: JSON.parse(unescape(block)) as Change[] };
};

const rename = (world: SynoikiaWorld, agent: string, params: Record<string, unknown>) =>
  world.call(agent, 'rename a list', params);

Given(
  'agent {word} waits for the admin to approve renaming {string} to {string}',
  async (world: SynoikiaWorld, agent: string, list: string, name: string) => {
    await rename(world, agent, { list, name });
    expect(world.answer).toMatchObject({ status: 'awaiting_approval' });
  },
);

Given('someone adds {string} to {string} in Acme', (world: SynoikiaWorld, title: string, list: string) => {
  world.lists.get(list)!.push({ title, done: false });
});

When(
  'agent {word} renames {string} to {string}',
  async (world: SynoikiaWorld, agent: string, list: string, name: string) => {
    await rename(world, agent, { list, name });
  },
);

When(
  'agent {word} renames {string} to {string} with the share password {string}',
  async (world: SynoikiaWorld, agent: string, list: string, name: string, sharePassword: string) => {
    await rename(world, agent, { list, name, sharePassword });
  },
);

Then(
  'the approval page shows the name {string} before and {string} after',
  async (world: SynoikiaWorld, before: string, after: string) => {
    const { changes } = await approvalPage(world);
    expect(changes).toEqual([{ path: '/name', before, after }]);
  },
);

Then('the approval page shows the share password as [REDACTED] before and after', async (world: SynoikiaWorld) => {
  const { changes } = await approvalPage(world);
  expect(changes.find((c) => c.path === '/sharePassword')).toEqual({
    path: '/sharePassword',
    before: '[REDACTED]',
    after: '[REDACTED]',
  });
});

Then('the approval page shows neither {string} nor {string}', async (world: SynoikiaWorld, a: string, b: string) => {
  const { html } = await approvalPage(world);
  expect(html).not.toContain(a);
  expect(html).not.toContain(b);
});

Then('agent {word} is told that the list changed in Acme', (world: SynoikiaWorld) => {
  expect(world.answer).toEqual({ error: 'CONFIG_CONFLICT', message: 'the list changed upstream' });
});

Then('Acme still has the list {string}', (world: SynoikiaWorld, list: string) => {
  expect(world.lists.has(list)).toBe(true);
});
