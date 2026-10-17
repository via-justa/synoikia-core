import { writeFileSync } from 'node:fs';
import { Given, Then, When } from 'quickpickle';
import { expect } from 'vitest';
import { OPERATIONS, opKey } from '../../support/world.js';
import type { SynoikiaWorld } from '../../support/world.js';

interface Entry {
  key: string;
  approval: 'none' | 'required' | 'auto';
  disabled?: true;
  reason?: string;
  paramsSchema?: { properties?: Record<string, unknown> };
  docs?: { summary?: string };
}

const nameOf = (key: string) => Object.entries(OPERATIONS).find(([, k]) => k === key)?.[0] ?? key;
const found = (world: SynoikiaWorld) => (world.answer.result ?? []) as Entry[];
const entry = (world: SynoikiaWorld, name: string) => {
  const e = found(world).find((o) => o.key === opKey(name));
  if (!e) throw new Error(`No catalog entry for "${name}": ${JSON.stringify(world.answer)}`);
  return e;
};

Given(
  'Acme also has the list {string} with the open task {string}',
  (world: SynoikiaWorld, list: string, a: string) => {
    world.lists.set(list, [{ title: a, done: false }]);
  },
);

Given(
  'Acme also has the list {string} with the open tasks {string} and {string}',
  (world: SynoikiaWorld, list: string, a: string, b: string) => {
    world.lists.set(list, [
      { title: a, done: false },
      { title: b, done: false },
    ]);
  },
);

Given('Acme removes {string} from {string}', (world: SynoikiaWorld, title: string, list: string) => {
  const tasks = world.lists.get(list)!;
  tasks.splice(
    tasks.findIndex((t) => t.title === title),
    1,
  );
});

Given('the list {string} has the description {string}', (world: SynoikiaWorld, list: string, description: string) => {
  world.descriptions.set(list, description);
});

Given('Acme has {int} saved views', (world: SynoikiaWorld, count: number) => {
  world.views = Array.from({ length: count }, (_, i) => `v${String(i).padStart(3, '0')}`);
});

Given('the admin syncs {string}', async (world: SynoikiaWorld, slug: string) => {
  await world.sync(slug);
});

Given(
  'the admin approved the add of {string} by agent {word} for this session',
  async (world: SynoikiaWorld, title: string, agent: string) => {
    await world.call(agent, 'add a task', { list: 'Groceries', title });
    const executionId = world.answer.executionId as string;
    await (await world.approvalPage('admin')).decide('approve_session');
    await world.resume(agent, executionId);
    expect(world.answer).toMatchObject({ result: { title } });
  },
);

Given(
  'the plugin of {string} ships the agent instructions {string}',
  async (world: SynoikiaWorld, _slug: string, text: string) => {
    writeFileSync(world.pluginFile('AGENTS.md'), text);
    await world.editManifest((m) => {
      m.instructions = 'AGENTS.md';
    });
  },
);

When('agent {word} searches the catalog of {string}', async (world: SynoikiaWorld, agent: string, slug: string) => {
  await world.search(agent, slug, 'return await catalog.find();');
});

When(
  'agent {word} searches the catalog of {string} twice',
  async (world: SynoikiaWorld, agent: string, slug: string) => {
    await world.search(agent, slug, 'return await catalog.find();');
    await world.search(agent, slug, 'return await catalog.find();');
  },
);

When(
  'agent {word} searches the catalog of {string} and includes what is off',
  async (world: SynoikiaWorld, agent: string, slug: string) => {
    await world.search(agent, slug, 'return await catalog.find({ includeDisabled: true });');
  },
);

When(
  'agent {word} searches the catalog of {string} for up to {int} operations',
  async (world: SynoikiaWorld, agent: string, slug: string, limit: number) => {
    await world.search(agent, slug, `return await catalog.find({ limit: ${limit} });`);
  },
);

const lookUp = async (world: SynoikiaWorld, agent: string, names: string[]) => {
  const keys = JSON.stringify(names.map(opKey));
  await world.search(agent, world.lastInstance, `return await Promise.all(${keys}.map((k) => catalog.get(k)));`);
};

When('agent {word} looks up {string} in the catalog', async (world: SynoikiaWorld, agent: string, name: string) => {
  await lookUp(world, agent, [name]);
});

When(
  'agent {word} looks up {string} and {string} in the catalog',
  async (world: SynoikiaWorld, agent: string, a: string, b: string) => {
    await lookUp(world, agent, [a, b]);
  },
);

When(
  'agent {word} asks for the details of {string} and of an operation that Acme does not have',
  async (world: SynoikiaWorld, agent: string, name: string) => {
    await world.search(
      agent,
      world.lastInstance,
      `return [await catalog.get(${JSON.stringify(opKey(name))}), await catalog.get('lists.everything')];`,
    );
  },
);

When('agent {word} asks for the groups of {string}', async (world: SynoikiaWorld, agent: string, slug: string) => {
  await world.search(agent, slug, 'return await catalog.groups();');
});

When(
  'the search code of agent {word} tries to add {string} to {string}',
  async (world: SynoikiaWorld, agent: string, title: string, list: string) => {
    const params = JSON.stringify({ list, title });
    await world.search(
      agent,
      world.lastInstance,
      `try { return await tasks.call('tasks.add', ${params}); } catch (e) { return e.message; }`,
    );
  },
);

When(
  'agent {word} looks in the registry for the tasks of {string}',
  async (world: SynoikiaWorld, agent: string, list: string) => {
    await world.search(
      agent,
      world.lastInstance,
      `return (await registry.find({ kind: 'task', parent: ${JSON.stringify(list)} })).map((e) => e.name);`,
    );
  },
);

When(
  'agent {word} looks in the registry for the list {string}',
  async (world: SynoikiaWorld, agent: string, list: string) => {
    await world.search(
      agent,
      world.lastInstance,
      `return (await registry.find({ kind: 'list', text: ${JSON.stringify(list)} }))[0];`,
    );
  },
);

When('agent {word} searches the registry for {string}', async (world: SynoikiaWorld, agent: string, text: string) => {
  await world.search(
    agent,
    world.lastInstance,
    `return (await registry.find({ text: ${JSON.stringify(text)} })).map((e) => e.name);`,
  );
});

When(
  'the admin searches the registry of {string} with the scope name {string}',
  async (world: SynoikiaWorld, slug: string, scope: string) => {
    const id = await world.tasksInstance(slug);
    const query = new URLSearchParams({ [`scope.${scope}`]: 'x' }).toString();
    await world.expectRefused(world.admin.get(`/api/instances/${id}/registry?${query}`), 'search the registry');
  },
);

When(
  'the app of agent {word} lists the tools of {string}',
  async (world: SynoikiaWorld, agent: string, slug: string) => {
    const { tools } = await (await world.session(agent, slug)).listTools();
    world.answer = { tools };
  },
);

When('agent {word} opens a session on {string}', async (world: SynoikiaWorld, agent: string, slug: string) => {
  const client = await world.connect(agent, slug);
  world.answer = { instructions: client.getInstructions() };
});

Then(
  'agent {word} finds only {string}, {string} and {string}',
  (world: SynoikiaWorld, _agent: string, a: string, b: string, c: string) => {
    expect(
      found(world)
        .map((o) => nameOf(o.key))
        .sort(),
    ).toEqual([a, b, c].sort());
  },
);

Then('agent {word} finds {int} operations', (world: SynoikiaWorld, _agent: string, count: number) => {
  expect(found(world)).toHaveLength(count);
});

Then(
  'agent {word} sees that {string} is off because its level is none',
  (world: SynoikiaWorld, _agent: string, name: string) => {
    expect(entry(world, name)).toMatchObject({ disabled: true, reason: 'level_none' });
  },
);

Then(
  'agent {word} sees that {string} is off because the admin has not opted in',
  (world: SynoikiaWorld, _agent: string, name: string) => {
    expect(entry(world, name)).toMatchObject({ disabled: true, reason: 'locked_not_opted_in' });
  },
);

Then('agent {word} reads that {string} asks a human first', (world: SynoikiaWorld, _agent: string, name: string) => {
  expect(entry(world, name).approval).toBe('required');
});

Then(
  'agent {word} reads that {string} runs without a question',
  (world: SynoikiaWorld, _agent: string, name: string) => {
    expect(entry(world, name).approval).toBe('auto');
  },
);

Then('agent {word} reads that {string} runs at once', (world: SynoikiaWorld, _agent: string, name: string) => {
  expect(entry(world, name).approval).toBe('none');
});

Then(
  'agent {word} sees the group {string} at {word} with {int} reads, {int} writes, {int} locked, {int} to acknowledge and {int} own level',
  (
    world: SynoikiaWorld,
    _agent: string,
    group: string,
    level: string,
    read: number,
    write: number,
    locked: number,
    pendingReview: number,
    overridden: number,
  ) => {
    const groups = world.answer.result as { key: string; level: string; counts: Record<string, number> }[];
    expect(groups.find((g) => g.key === group)).toMatchObject({
      level,
      counts: { read, write, locked, pendingReview, overridden },
    });
  },
);

Then('agent {word} sees only the group {string}', (world: SynoikiaWorld, _agent: string, group: string) => {
  expect((world.answer.result as { key: string }[]).map((g) => g.key)).toEqual([group]);
});

Then('agent {word} is told that search has no to-do functions', (world: SynoikiaWorld) => {
  expect(world.answer.result).toMatch(/tasks is not defined/);
});

Then(
  'the audit log shows {int} searches by agent {word}',
  async (world: SynoikiaWorld, count: number, agent: string) => {
    const rows = await world.audit({ kind: 'search' });
    expect(rows.filter((r) => (r as { actorId?: string }).actorId === `token:agent ${agent}`)).toHaveLength(count);
  },
);

Then(
  'agent {word} reads that {string} takes a list and a title, with the summary {string}',
  (world: SynoikiaWorld, _agent: string, name: string, summary: string) => {
    const [details] = world.answer.result as Entry[];
    expect(details).toMatchObject({ key: opKey(name), docs: { summary } });
    expect(Object.keys(details!.paramsSchema!.properties!)).toEqual(['list', 'title']);
  },
);

Then('agent {word} gets no details for the operation that Acme does not have', (world: SynoikiaWorld) => {
  expect((world.answer.result as unknown[])[1]).toBeNull();
});

Then('agent {word} gets {string} and {string}', (world: SynoikiaWorld, _agent: string, a: string, b: string) => {
  expect(world.answer).toEqual({ result: [a, b] });
});

Then('agent {word} gets only {string}', (world: SynoikiaWorld, _agent: string, a: string) => {
  expect(world.answer).toEqual({ result: [a] });
});

Then('agent {word} gets nothing', (world: SynoikiaWorld) => {
  expect(world.answer).toEqual({ result: [] });
});

Then('agent {word} reads the description {string}', (world: SynoikiaWorld, _agent: string, description: string) => {
  expect(world.answer.result).toMatchObject({ attrs: { description } });
});

Then('the admin is told that {string} is not a scope name', (world: SynoikiaWorld, scope: string) => {
  expect(world.portalAnswer.body).toMatchObject({ message: `"${scope}" is not a scope key` });
});

const tool = (world: SynoikiaWorld, name: string) =>
  (world.answer.tools as { name: string; annotations?: Record<string, boolean> }[]).find((t) => t.name === name)!;

Then('the app sees that search changes nothing', (world: SynoikiaWorld) => {
  expect(tool(world, 'search').annotations).toMatchObject({ readOnlyHint: true });
});

Then('the app sees that running code can change and destroy things', (world: SynoikiaWorld) => {
  expect(tool(world, 'execute').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
});

const CORE_TEXT =
  'Acme Tasks (World fixture) via Synoikia. Use search to discover operations, then execute to call them.';

Then(
  "the app of agent {word} gets core's instructions, then {string}",
  (world: SynoikiaWorld, _agent: string, text: string) => {
    const instructions = world.answer.instructions as string;
    expect(instructions.startsWith(CORE_TEXT)).toBe(true);
    expect(instructions).toMatch(new RegExp(`<plugin-notes plugin="tasks">[\\s\\S]*${text}[\\s\\S]*</plugin-notes>`));
  },
);

Then("the app of agent {word} gets only core's instructions", (world: SynoikiaWorld) => {
  const instructions = world.answer.instructions as string;
  expect(instructions.startsWith(CORE_TEXT)).toBe(true);
  expect(instructions).not.toContain('plugin-notes');
});
