import { Given, Then } from 'quickpickle';
import { expect } from 'vitest';
import type { SynoikiaWorld } from '../../support/world.js';

Given(
  'agent {word} waits for the admin to approve completing {string} in {string}',
  async (world: SynoikiaWorld, agent: string, title: string, list: string) => {
    await world.call(agent, 'complete a task', { list, title });
    expect(world.answer).toMatchObject({ status: 'awaiting_approval' });
  },
);

Given('Acme gets a second open task {string} in {string}', (world: SynoikiaWorld, title: string, list: string) => {
  world.lists.get(list)!.push({ title, done: false });
});

Then('agent {word} is told that what the call acts on changed while it waited', (world: SynoikiaWorld) => {
  expect(world.answer).toMatchObject({ error: 'TARGETS_CHANGED' });
});

Then('the audit log records both {string} tasks as the targets now', async (world: SynoikiaWorld, title: string) => {
  const rows = await world.audit({ kind: 'call', decision: 'rejected:targets_changed' });
  expect(rows).toHaveLength(1);
  const now = rows[0]!.detail!.targetsNow as { name: string }[];
  expect(now.map((t) => t.name)).toEqual([title, title]);
});

Then(
  'agent {word} is told that the plugin cannot find the list {string}',
  (world: SynoikiaWorld, _agent: string, list: string) => {
    expect(world.answer).toEqual({ error: 'TARGET_RESOLUTION_FAILED', message: `no list ${list}` });
  },
);
