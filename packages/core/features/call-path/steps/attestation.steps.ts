import { Given, Then, When } from 'quickpickle';
import { expect } from 'vitest';
import { opKey } from '../../support/world.js';
import type { SynoikiaWorld } from '../../support/world.js';

/** The keys an agent got from reading guides, in the order it read them. */
const keys = new WeakMap<SynoikiaWorld, string[]>();
const keysOf = (world: SynoikiaWorld) => keys.get(world) ?? [];

const readGuide = async (world: SynoikiaWorld, agent: string, name: string) => {
  const key = await world.readGuide(agent, name);
  if (!key) throw new Error(`No key from the guide: ${JSON.stringify(world.answer)}`);
  keys.set(world, [...keysOf(world), key]);
};

const importTasks = (world: SynoikiaWorld, agent: string, list: string, titles: string[], key?: string) =>
  world.call(agent, 'import tasks', { list, tasks: titles, ...(key === undefined ? {} : { best_practice_key: key }) });

Given('agent {word} read the guide of {string}', async (world: SynoikiaWorld, agent: string, name: string) => {
  await readGuide(world, agent, name);
});

Given('agent {word} reads the guide of {string} again', async (world: SynoikiaWorld, agent: string, name: string) => {
  await readGuide(world, agent, name);
});

Given('agent {word} opens a new session on {string}', async (world: SynoikiaWorld, agent: string, slug: string) => {
  const before = world.sessionId(agent);
  await world.connect(agent, slug);
  expect(world.sessionId(agent)).not.toBe(before);
});

Given(
  'Acme publishes version {word} of the guide of {string}',
  (world: SynoikiaWorld, version: string, name: string) => {
    world.guides.set(opKey(name), { version, content: `Version ${version}: import at most 50 tasks at once.` });
  },
);

When('agent {word} reads the guide of {string}', async (world: SynoikiaWorld, agent: string, name: string) => {
  await readGuide(world, agent, name);
});

When(
  'agent {word} imports {string} and {string} into {string} without a key',
  async (world: SynoikiaWorld, agent: string, a: string, b: string, list: string) => {
    await importTasks(world, agent, list, [a, b]);
  },
);

When(
  'agent {word} imports {string} and {string} into {string} with the key of that guide',
  async (world: SynoikiaWorld, agent: string, a: string, b: string, list: string) => {
    await importTasks(world, agent, list, [a, b], keysOf(world).at(-1));
  },
);

When(
  'agent {word} imports {string} and {string} into {string} with the key of the first guide',
  async (world: SynoikiaWorld, agent: string, a: string, b: string, list: string) => {
    await importTasks(world, agent, list, [a, b], keysOf(world)[0]);
  },
);

When(
  'agent {word} imports {string} and {string} into {string} with the key {string}',
  async (world: SynoikiaWorld, agent: string, a: string, b: string, list: string, key: string) => {
    await importTasks(world, agent, list, [a, b], key);
  },
);

Then(
  'agent {word} is told to read the guide of {string} first',
  (world: SynoikiaWorld, _agent: string, name: string) => {
    expect(world.answer).toEqual({
      error: 'ATTESTATION_REQUIRED',
      message: `Call search() for the ${opKey(name)} guide first and pass its best_practice_key`,
    });
  },
);

Then(
  'the list {string} holds the open tasks {string}, {string}, {string}, {string} and {string}',
  (world: SynoikiaWorld, list: string, a: string, b: string, c: string, d: string, e: string) => {
    expect(
      world.lists
        .get(list)!
        .filter((t) => !t.done)
        .map((t) => t.title),
    ).toEqual([a, b, c, d, e]);
  },
);

Then(
  'the audit log shows that agent {word} read version {word} of the guide of {string} in its session',
  async (world: SynoikiaWorld, agent: string, version: string, name: string) => {
    const rows = await world.audit({ kind: 'search', decision: 'guide_read' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      operationKey: opKey(name),
      detail: { guideVersion: version, mcpSessionId: world.sessionId(agent) },
    });
  },
);
