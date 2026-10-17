import { Given, Then, When } from 'quickpickle';
import { expect } from 'vitest';
import { eventually } from '../../support/world.js';
import type { SynoikiaWorld } from '../../support/world.js';

/** Runs a step started and a later step waits for. */
const started = new WeakMap<SynoikiaWorld, Promise<unknown>[]>();

const add = async (world: SynoikiaWorld, agent: string, title: string, list: string) => {
  await world.call(agent, 'add a task', { list, title });
  expect(world.answer).toMatchObject({ result: { title } });
};

Given(
  '{string} allows each credential {int} writes a minute',
  async (world: SynoikiaWorld, slug: string, writesPerMinute: number) => {
    await world.instanceSettings(slug, { writesPerMinute });
  },
);

Given(
  '{string} allows each credential {int} runs a minute',
  async (world: SynoikiaWorld, slug: string, executePerMinute: number) => {
    await world.instanceSettings(slug, { executePerMinute });
  },
);

Given(
  'agent {word} counted {string} three times in one run, and searched the catalog once',
  async (world: SynoikiaWorld, agent: string, list: string) => {
    const count = `(await tasks.call('lists.count', ${JSON.stringify({ list })})).open`;
    await world.execute(agent, world.lastInstance, `return [${count}, ${count}, ${count}];`);
    expect(world.answer).toEqual({ result: [3, 3, 3] });
    await world.search(agent, world.lastInstance, 'return (await catalog.find()).length;');
    expect(world.answer.result).toEqual(expect.any(Number));
  },
);

Given('agent {word} used up its runs', async (world: SynoikiaWorld, agent: string) => {
  for (let i = 0; i < 2; i++) {
    await world.execute(agent, world.lastInstance, 'return 1;');
    expect(world.answer).toEqual({ result: 1 });
  }
});

Given(
  'agents {word} and {word} each have a credential of the admin named {string}',
  async (world: SynoikiaWorld, a: string, b: string, name: string) => {
    await world.credential(a, 'admin', 'write', name);
    await world.credential(b, 'admin', 'write', name);
  },
);

Given('the admin denied three adds of agent {word}', async (world: SynoikiaWorld, agent: string) => {
  for (const title of ['salt', 'pepper', 'oil']) {
    await world.call(agent, 'add a task', { list: 'Groceries', title });
    const executionId = world.answer.executionId as string;
    await (await world.approvalPage('admin')).decide('deny');
    await world.resume(agent, executionId);
    expect(world.answer).toMatchObject({ error: 'PERMISSION_DENIED' });
  }
});

Given(
  'agent {word} added {string} and {string} to {string}',
  async (world: SynoikiaWorld, agent: string, a: string, b: string, list: string) => {
    await add(world, agent, a, list);
    await add(world, agent, b, list);
  },
);

Given(
  'agent {word} added {string} to {string}',
  async (world: SynoikiaWorld, agent: string, title: string, list: string) => {
    await add(world, agent, title, list);
  },
);

Given('Acme takes {int} second(s) to answer', (world: SynoikiaWorld, seconds: number) => {
  world.upstreamDelayMs = seconds * 1000;
});

Given(
  'agent {word} started four reads of {string} that wait for Acme',
  async (world: SynoikiaWorld, agent: string, list: string) => {
    const client = await world.session(agent, world.lastInstance);
    const code = `return (await tasks.call('lists.tasks', ${JSON.stringify({ list })})).length;`;
    const reads = () => world.upstreamRequests('GET', `/lists/${list}/tasks`).filter((r) => !r.query.has('with'));
    const before = reads().length;
    const runs = Array.from({ length: 4 }, () => client.callTool({ name: 'execute', arguments: { code } }));
    // A scenario may end before these runs do; the World then closes the session under them.
    for (const run of runs) run.catch(() => undefined);
    started.set(world, runs);
    await eventually(() => reads().length >= before + 4, 'four reads at Acme');
  },
);

Given('those four reads ended', async (world: SynoikiaWorld) => {
  const results = (await Promise.all(started.get(world)!)) as { content: { text: string }[] }[];
  expect(results.map((r) => JSON.parse(r.content[0]!.text) as unknown)).toEqual(Array(4).fill({ result: 3 }));
});

Given(
  'agents {word} and {word} each wait for the admin to approve two adds',
  async (world: SynoikiaWorld, a: string, b: string) => {
    for (const agent of [a, b])
      for (const title of ['salt', 'pepper']) {
        await world.call(agent, 'add a task', { list: 'Groceries', title });
        expect(world.answer).toMatchObject({ status: 'awaiting_approval' });
      }
  },
);

When('agent {word} runs code that returns {int}', async (world: SynoikiaWorld, agent: string, value: number) => {
  await world.execute(agent, world.lastInstance, `return ${value};`);
});

Then('agent {word} is told that it made too many runs, and to slow down', (world: SynoikiaWorld) => {
  expect(world.answer).toEqual({ error: 'RATE_LIMITED', message: 'Too many search/execute calls; slow down' });
});

Then('agent {word} is told that it made too many writes, and to slow down', (world: SynoikiaWorld) => {
  expect(world.answer).toEqual({ error: 'RATE_LIMITED', message: 'Too many write calls; slow down' });
});

Then('agent {word} gets the value {int}', (world: SynoikiaWorld, _agent: string, value: number) => {
  expect(world.answer).toEqual({ result: value });
});

Then('agent {word} is told that core is busy', (world: SynoikiaWorld) => {
  expect(world.answer).toMatchObject({ error: 'BUSY' });
});

Then('the list {string} holds the open task {string}', (world: SynoikiaWorld, list: string, title: string) => {
  expect(
    world.lists
      .get(list)!
      .filter((t) => !t.done)
      .map((t) => t.title),
  ).toContain(title);
});
