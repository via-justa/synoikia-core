import { Given, Then, When } from 'quickpickle';
import { expect } from 'vitest';
import { API_TOKEN, eventually, opKey } from '../../support/world.js';
import type { Prompt, SynoikiaWorld } from '../../support/world.js';

/** What a step saw along the way that a later step checks: the first approval, the app's prompts. */
const seen = new WeakMap<SynoikiaWorld, { firstSummary?: string; prompts: Prompt[] }>();
const seenBy = (world: SynoikiaWorld) => {
  let s = seen.get(world);
  if (!s) seen.set(world, (s = { prompts: [] }));
  return s;
};

type CallRow = {
  decision: string;
  operationKey: string | null;
  params?: Record<string, unknown> | null;
  detail: Record<string, unknown> | null;
};

const calls = async (world: SynoikiaWorld, name: string) =>
  (await world.audit({ kind: 'call', operation: opKey(name) })) as CallRow[];

const addsOf = async (world: SynoikiaWorld, title: string) =>
  (await calls(world, 'add a task')).filter((r) => r.params?.title === title);

const expectWaiting = (world: SynoikiaWorld) =>
  expect(world.answer).toMatchObject({ status: 'awaiting_approval', approval: { url: expect.any(String) as string } });

const pluginUpdate = async (world: SynoikiaWorld, version: string) => {
  await world.editManifest((m) => {
    m.version = version;
  });
  await world.restartPlugin(world.lastInstance);
};

Given('the list {string} has the share password {string}', (world: SynoikiaWorld, list: string, password: string) => {
  world.sharePasswords.set(list, password);
});

Given('Acme refuses every request for lack of permission', (world: SynoikiaWorld) => {
  world.upstreamFault = 'denied';
});

Given('Acme answers every request with an error that quotes the API token', (world: SynoikiaWorld) => {
  world.upstreamFault = 'leaky';
});

Given('the plugin of {string} is down', (world: SynoikiaWorld) => {
  world.pluginFlag('down');
});

Given(
  'the plugin of {string} was updated to version {word}',
  async (world: SynoikiaWorld, _slug: string, version: string) => {
    await pluginUpdate(world, version);
  },
);

Given(
  'the plugin of {string} was updated to version {word}, and it cannot list its operations',
  async (world: SynoikiaWorld, _slug: string, version: string) => {
    world.pluginFlag('catalog-broken');
    await pluginUpdate(world, version.replace(/,$/, ''));
  },
);

Given('the app of agent {word} shows approval links', async (world: SynoikiaWorld, agent: string) => {
  await world.connect(agent, world.lastInstance, {
    mode: 'url',
    answer: (p) => {
      seenBy(world).prompts.push(p);
      return Promise.resolve('accept');
    },
  });
});

Given(
  'agent {word} waits for the admin to approve the add of {string} to {string}',
  async (world: SynoikiaWorld, agent: string, title: string, list: string) => {
    await world.call(agent, 'add a task', { list, title });
    expectWaiting(world);
  },
);

Given(
  'a run on {string} may take {int} second, and Acme takes {int} seconds to answer',
  async (world: SynoikiaWorld, slug: string, run: number, upstream: number) => {
    await world.instanceSettings(slug, { sandbox: { timeoutMs: run * 1000 } });
    world.upstreamDelayMs = upstream * 1000;
  },
);

When(
  'agent {word} asks for the share password of {string}',
  async (world: SynoikiaWorld, agent: string, list: string) => {
    await world.call(agent, 'show the share password', { list });
  },
);

When('agent {word} calls the operation {string}', async (world: SynoikiaWorld, agent: string, name: string) => {
  await world.execute(
    agent,
    world.lastInstance,
    `return await tasks.call(${JSON.stringify(`lists.${name.replace(/\s+/g, '-')}`)}, {});`,
  );
});

When(
  'the code of agent {word} adds {string} to {string} and catches the refusal',
  async (world: SynoikiaWorld, agent: string, title: string, list: string) => {
    const params = JSON.stringify({ list, title });
    await world.execute(
      agent,
      world.lastInstance,
      `try { await tasks.call('tasks.add', ${params}); return 'added'; } catch (e) { return { code: e.code, message: e.message }; }`,
    );
  },
);

When(
  'the search code of agent {word} looks in the registry with the scope name {string}',
  async (world: SynoikiaWorld, agent: string, scope: string) => {
    await world.search(
      agent,
      world.lastInstance,
      `return await registry.find({ scopes: { ${JSON.stringify(scope)}: 'x' } });`,
    );
  },
);

When(
  'agent {word} adds {string} and {string} to {string} at the same time, and the admin approves the first add',
  async (world: SynoikiaWorld, agent: string, a: string, b: string, list: string) => {
    const add = (title: string) => `tasks.call('tasks.add', ${JSON.stringify({ list, title })})`;
    await world.execute(agent, world.lastInstance, `return await Promise.all([${add(a)}, ${add(b)}]);`);
    expectWaiting(world);
    seenBy(world).firstSummary = (world.answer.approval as { summary: string }).summary;
    await world.approveAndResume(agent, 'admin');
  },
);

When(
  'the code of agent {word} starts to add {string} to {string} and returns without waiting',
  async (world: SynoikiaWorld, agent: string, title: string, list: string) => {
    const params = JSON.stringify({ list, title });
    await world.execute(agent, world.lastInstance, `tasks.call('tasks.add', ${params}); return 'returned';`);
    expect(world.answer).toEqual({ result: 'returned' });
  },
);

When(
  'agent {word} cancels its request while the add of {string} to {string} waits for approval',
  async (world: SynoikiaWorld, agent: string, title: string, list: string) => {
    const request = new AbortController();
    const run = world.execute(
      agent,
      world.lastInstance,
      `return await tasks.call('tasks.add', ${JSON.stringify({ list, title })});`,
      request.signal,
    );
    await eventually(() => seenBy(world).prompts.length === 1, 'the approval link');
    request.abort();
    await run;
  },
);

When(
  'agent {word} counts the open tasks of {string} twice in one run',
  async (world: SynoikiaWorld, agent: string, list: string) => {
    const count = `tasks.call('lists.count', ${JSON.stringify({ list })})`;
    await world.execute(agent, world.lastInstance, `return [await ${count}, await ${count}];`);
  },
);

When('the admin approves the call and agent {word} resumes it', async (world: SynoikiaWorld, agent: string) => {
  await world.approveAndResume(agent, 'admin');
});

Then('the audit log shows that {string} ran at once', async (world: SynoikiaWorld, name: string) => {
  expect((await calls(world, name)).map((r) => r.decision)).toEqual(['auto-executed']);
});

Then(
  'agent {word} sees the share password of {string} as [REDACTED]',
  (world: SynoikiaWorld, _agent: string, list: string) => {
    expect(world.answer).toEqual({ result: { list, password: '[REDACTED]' } });
  },
);

Then(
  'agent {word} is told that {string} is an unknown operation',
  (world: SynoikiaWorld, _agent: string, name: string) => {
    expect(world.answer).toEqual({
      error: 'UNKNOWN_OPERATION',
      message: `unknown operation: lists.${name.replace(/\s+/g, '-')}`,
    });
  },
);

Then('the audit log records the unknown operation as refused', async (world: SynoikiaWorld) => {
  const rows = await world.audit({ kind: 'call', decision: 'rejected:unknown_operation' });
  expect(rows).toHaveLength(1);
});

Then('the code of agent {word} reads that the access level is none', (world: SynoikiaWorld) => {
  expect(world.answer).toEqual({
    result: {
      code: 'OPERATION_DISABLED',
      message: `${opKey('add a task')} is disabled on this endpoint (access level None)`,
    },
  });
});

Then('agent {word} is told only that there was an internal error', (world: SynoikiaWorld) => {
  expect(world.answer).toEqual({ error: 'INTERNAL', message: 'Internal error in binding' });
});

Then('agent {word} is told that Acme denied the call for lack of permission', (world: SynoikiaWorld) => {
  expect(world.answer).toEqual({ error: 'UPSTREAM_DENIED', message: 'insufficient permission' });
});

Then('the audit log records the read of {string} as an error', async (world: SynoikiaWorld, name: string) => {
  expect((await calls(world, name)).map((r) => r.decision)).toEqual(['error:UPSTREAM_DENIED']);
});

Then('agent {word} is told that the plugin is not available', (world: SynoikiaWorld) => {
  expect(world.answer).toMatchObject({ error: 'PLUGIN_UNAVAILABLE' });
});

Then('agent {word} is told that Acme answered {string}', (world: SynoikiaWorld, _agent: string, text: string) => {
  expect(world.answer).toMatchObject({ error: 'UPSTREAM_ERROR', message: expect.stringContaining(text) as string });
  expect(JSON.stringify(world.answer)).not.toContain(API_TOKEN);
});

Then(
  'agent {word} was first asked about {string} alone, and then about {string}',
  (world: SynoikiaWorld, _agent: string, a: string, b: string) => {
    const first = seenBy(world).firstSummary!;
    expect(first).toContain(`"${a}"`);
    expect(first).not.toContain(`"${b}"`);
    expectWaiting(world);
    expect((world.answer.approval as { summary: string }).summary).toBe(`add a task: "${b}" in Groceries`);
  },
);

Then('Acme never receives {string}', (world: SynoikiaWorld, title: string) => {
  const adds = world.upstream!.requests.filter((r) => r.method === 'POST' && /\/tasks$/.test(r.path));
  expect(adds.filter((r) => (r.body as { title?: string }).title === title)).toEqual([]);
});

Then('the audit log shows that the add of {string} ended with its run', async (world: SynoikiaWorld, title: string) => {
  let rows: CallRow[] = [];
  await eventually(async () => (rows = await addsOf(world, title)).length > 0, 'the audit of the add');
  expect(rows.map((r) => r.decision)).toEqual(['rejected:execution_ended']);
});

Then('nobody was asked to approve the add of {string}', async (world: SynoikiaWorld, title: string) => {
  expect((await addsOf(world, title)).filter((r) => r.decision === 'awaiting_approval')).toEqual([]);
  expect(seenBy(world).prompts).toEqual([]);
});

Then('the approval link of the add no longer opens', async (world: SynoikiaWorld) => {
  const link = new URL(seenBy(world).prompts[0]!.url!);
  const res = await fetch(`${world.mcpBase}${link.pathname}`, { redirect: 'manual' });
  expect(res.status).toBe(404);
  expect(await res.text()).toContain('expired or was already decided');
});

Then('agent {word} is told that the plugin changed while the call waited', (world: SynoikiaWorld) => {
  expect(world.answer).toEqual({
    error: 'PLUGIN_UNAVAILABLE',
    message: 'The plugin changed while this call was pending (an update or restart); call it again',
  });
});

Then('Acme sees a different call id on each of the {int} calls', (world: SynoikiaWorld, count: number) => {
  const ids = world.upstream!.requests.map((r) => r.headers['x-call-id']).filter((id) => id !== undefined);
  expect(ids).toHaveLength(count);
  expect(new Set(ids).size).toBe(count);
});

Then('agent {word} is told that the result of the add is unknown', (world: SynoikiaWorld) => {
  expect(world.answer).toMatchObject({ error: 'UPSTREAM_TIMEOUT' });
});

Then('the audit log records the add of {string} as timed out', async (world: SynoikiaWorld, title: string) => {
  let rows: CallRow[] = [];
  await eventually(async () => (rows = await addsOf(world, title)).length > 0, 'the audit of the add');
  expect(rows.map((r) => r.decision)).toEqual(['error:UPSTREAM_TIMEOUT']);
});
