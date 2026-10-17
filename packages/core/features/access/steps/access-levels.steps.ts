import { Given, Then, When } from 'quickpickle';
import { expect } from 'vitest';
import { opKey } from '../../support/world.js';
import type { SynoikiaWorld } from '../../support/world.js';

Given(
  'the instance {string} has the list {string} with the open tasks {string}, {string} and {string}',
  async (world: SynoikiaWorld, slug: string, list: string, a: string, b: string, c: string) => {
    world.lists.set(
      list,
      [a, b, c].map((title) => ({ title, done: false })),
    );
    await world.tasksInstance(slug);
  },
);

Given('agent {word} belongs to the admin and may read and write', async (world: SynoikiaWorld, agent: string) => {
  await world.credential(agent, 'admin', 'write');
});

Given('the admin gave agent {word} a read-only credential instead', async (world: SynoikiaWorld, agent: string) => {
  await world.credential(agent, 'admin', 'read');
});

Given(
  'the admin makes a credential for agent {word} and keeps the access it offers',
  async (world: SynoikiaWorld, agent: string) => {
    await world.credential(agent, 'admin');
  },
);

Given(
  'the admin sets the group {string} of {string} to {word}',
  async (world: SynoikiaWorld, group: string, slug: string, level: string) => {
    await world.setGroupLevel(slug, group, level);
  },
);

Given(
  'the group {string} of {string} is at level {word}',
  async (world: SynoikiaWorld, group: string, slug: string, level: string) => {
    await world.setGroupLevel(slug, group, level);
  },
);

Given('agent {word} has an open session on {string}', async (world: SynoikiaWorld, agent: string, slug: string) => {
  await world.session(agent, slug);
});

Given('the admin gives {string} its own level {word}', async (world: SynoikiaWorld, name: string, level: string) => {
  await world.setOperationLevel(world.lastInstance, name, level);
});

Given('the admin withdraws the acknowledgement of {string}', async (world: SynoikiaWorld, name: string) => {
  await world.acknowledge(world.lastInstance, name, false);
});

Given(
  'agent {word} asked for the open tasks of {string} and the admin approved it',
  async (world: SynoikiaWorld, agent: string, list: string) => {
    await world.call(agent, 'show the open tasks', { list });
    expect(world.answer.status).toBe('awaiting_approval');
    await world.approveAndResume(agent, 'admin');
    expect(world.answer.result).toEqual(world.lists.get(list)!.filter((t) => !t.done));
  },
);

When('the admin sets the group {string} to {word}', async (world: SynoikiaWorld, group: string, level: string) => {
  await world.setGroupLevel(world.lastInstance, group, level);
});

When(
  'the admin tries to give {string} its own level {word}',
  async (world: SynoikiaWorld, name: string, level: string) => {
    await world.setOperationLevel(world.lastInstance, name, level, 'refused');
  },
);

When('the admin looks at the operations of {string}', async (world: SynoikiaWorld, slug: string) => {
  await world.operations(slug);
});

const openTasks = (list: string) =>
  `return (await tasks.call('lists.tasks', { list: ${JSON.stringify(list)} })).map((t) => t.title);`;

When('agent {word} asks for the open tasks of {string}', async (world: SynoikiaWorld, agent: string, list: string) => {
  await world.execute(agent, world.lastInstance, openTasks(list));
});

When(
  'agent {word} asks again for the open tasks of {string} in the same session',
  async (world: SynoikiaWorld, agent: string, list: string) => {
    expect(world.agents.get(agent)!.client).toBeDefined();
    await world.execute(agent, world.lastInstance, openTasks(list));
  },
);

When('agent {word} counts the open tasks of {string}', async (world: SynoikiaWorld, agent: string, list: string) => {
  await world.call(agent, 'count the tasks', { list });
});

When(
  'agent {word} adds {string} to {string}',
  async (world: SynoikiaWorld, agent: string, title: string, list: string) => {
    await world.call(agent, 'add a task', { list, title });
  },
);

When(
  'agent {word} completes {string} in {string}',
  async (world: SynoikiaWorld, agent: string, title: string, list: string) => {
    await world.call(agent, 'complete a task', { list, title });
  },
);

When('agent {word} deletes the list {string}', async (world: SynoikiaWorld, agent: string, list: string) => {
  await world.call(agent, 'delete a list', { list });
});

Then(
  'agent {word} gets {string}, {string} and {string}',
  (world: SynoikiaWorld, _agent: string, a: string, b: string, c: string) => {
    expect(world.answer).toEqual({ result: [a, b, c] });
  },
);

Then(
  'agent {word} is told that {string} has {int} open tasks',
  (world: SynoikiaWorld, _agent: string, _list: string, open: number) => {
    expect(world.answer).toEqual({ result: { open } });
  },
);

const disabled = (pattern: RegExp) => ({
  error: 'OPERATION_DISABLED',
  message: expect.stringMatching(pattern) as string,
});

Then('agent {word} is told that the admin turned the operation off, and gets no tasks', (world: SynoikiaWorld) => {
  expect(world.answer).toEqual(disabled(/access level None/));
});

Then('agent {word} is told that the admin turned the operation off', (world: SynoikiaWorld) => {
  expect(world.answer).toEqual(disabled(/access level None/));
});

Then('agent {word} is told that its credential has read-only access', (world: SynoikiaWorld) => {
  expect(world.answer).toEqual(disabled(/granted read-only access/));
});

Then(
  'agent {word} is told that the operation is protected and the admin has not enabled it',
  (world: SynoikiaWorld) => {
    expect(world.answer).toEqual(disabled(/protected operation that the administrator has not enabled/));
  },
);

Then('agent {word} is told that the call waits for a human to approve it', (world: SynoikiaWorld) => {
  expect(world.answer).toMatchObject({ status: 'awaiting_approval', approval: { url: expect.any(String) as string } });
});

Then(
  'the list {string} still holds the open tasks {string}, {string} and {string}',
  (world: SynoikiaWorld, list: string, a: string, b: string, c: string) => {
    expect(
      world.lists
        .get(list)!
        .filter((t) => !t.done)
        .map((t) => t.title),
    ).toEqual([a, b, c]);
  },
);

Then(
  'the list {string} holds the open tasks {string}, {string}, {string} and {string}',
  (world: SynoikiaWorld, list: string, a: string, b: string, c: string, d: string) => {
    expect(
      world.lists
        .get(list)!
        .filter((t) => !t.done)
        .map((t) => t.title),
    ).toEqual([a, b, c, d]);
  },
);

Then(
  'the list {string} holds only the open tasks {string} and {string}',
  (world: SynoikiaWorld, list: string, a: string, b: string) => {
    expect(
      world.lists
        .get(list)!
        .filter((t) => !t.done)
        .map((t) => t.title),
    ).toEqual([a, b]);
  },
);

Then('the audit log shows that the level of the group approved the add', async (world: SynoikiaWorld) => {
  const rows = await world.audit({ kind: 'call', operation: opKey('add a task') });
  expect(rows.map((r) => r.decision)).toEqual(['auto-approved:level']);
});

Then(
  'the audit log shows that the admin acknowledged {string}, {string} and {string}',
  async (world: SynoikiaWorld, a: string, b: string, c: string) => {
    const rows = await world.audit({ kind: 'config', decision: 'group_level_changed' });
    expect(rows[0]!.detail).toMatchObject({ acknowledged: [a, b, c].map(opKey) });
  },
);

Then(
  'the group {string} shows {int} operation to acknowledge',
  async (world: SynoikiaWorld, group: string, count: number) => {
    const groups = await world.groups(world.lastInstance);
    expect(groups.find((g) => g.key === group)!.counts.pendingReview).toBe(count);
  },
);

Then('the admin sees that {string} is acknowledged', async (world: SynoikiaWorld, name: string) => {
  expect((await world.operation(world.lastInstance, name)).writeAcknowledged).toBe(true);
});

Then(
  'the admin sees that {string} follows its group at level {word}',
  async (world: SynoikiaWorld, name: string, level: string) => {
    expect(await world.operation(world.lastInstance, name)).toMatchObject({ levelOverride: null, level });
  },
);

Then(
  'the admin can give {string} only the levels {word}, {word} and {word}',
  async (world: SynoikiaWorld, name: string, a: string, b: string, c: string) => {
    expect((await world.operation(world.lastInstance, name)).allowedLevels).toEqual([a.replace(/,$/, ''), b, c]);
  },
);

Then(
  'the admin can give {string} only the levels {word} and {word}',
  async (world: SynoikiaWorld, name: string, a: string, b: string) => {
    expect((await world.operation(world.lastInstance, name)).allowedLevels).toEqual([a, b]);
  },
);

Then('the admin is told that {string} takes only none, ask or write', (world: SynoikiaWorld, name: string) => {
  expect(world.portalAnswer.body).toMatchObject({
    message: expect.stringContaining(`${opKey(name)} is a write; its level must be one of none, ask, write`) as string,
  });
});

Then('the admin is told that {string} is locked and always asks', (world: SynoikiaWorld, name: string) => {
  expect(world.portalAnswer.body).toMatchObject({
    message: `${opKey(name)} is locked; it always asks for approval`,
  });
});

Then('the approval page asks the admin to type {string} to approve', async (world: SynoikiaWorld, literal: string) => {
  const page = await world.approvalPage('admin');
  expect(page.html).toContain(`Type <code>${literal}</code> to approve`);
});
