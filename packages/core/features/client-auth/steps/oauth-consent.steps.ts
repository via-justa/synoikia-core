import { Given, Then, When } from 'quickpickle';
import { expect } from 'vitest';
import type { SynoikiaWorld } from '../../support/world.js';
import { auditRows } from '../../administration/steps/administration.js';
import type { Flow } from './client-auth.js';
import { clientAuth, consentForm, decide, flowFor, oauthSignIn, REDIRECT, signInForFlow } from './client-auth.js';

const person = (user: number) => `user ${user}`;
const app = (world: SynoikiaWorld, name: string) => {
  const found = clientAuth(world).apps.get(name);
  if (!found) throw new Error(`the admin has not registered "${name}"`);
  return found;
};
const flowOf = (world: SynoikiaWorld) => {
  const flow = clientAuth(world).flow;
  if (!flow) throw new Error('nobody opened a sign-in yet');
  return flow;
};

When(
  /^user (\d+) opens the sign-in of "([^"]+)" and gives their password$/,
  async (world: SynoikiaWorld, user: string, name: string) => {
    await signInForFlow(world, flowFor(app(world, name)), person(Number(user)));
  },
);

Given(
  'user {int} opened the sign-in of {string} and gave their password',
  async (world: SynoikiaWorld, user: number, name: string) => {
    const page = await signInForFlow(world, flowFor(app(world, name)), person(user));
    expect(page.html).toContain(`Authorize ${name}`);
  },
);

When(
  'user {int} opens the sign-in of {string} for {string} and gives their password',
  async (world: SynoikiaWorld, user: number, name: string, slug: string) => {
    await world.tasksInstance(slug);
    const flow = flowFor(app(world, name), { resource: `${world.mcpBase}/${slug}` });
    await signInForFlow(world, flow, person(user));
  },
);

Then(
  'user {int} sees {string}, the return host {string} and the instance {string}',
  (world: SynoikiaWorld, _user: number, title: string, host: string, slug: string) => {
    const { html } = flowOf(world).page!;
    expect(html).toContain(`<h1>${title}</h1>`);
    expect(html).toContain(`<code>${host}</code>`);
    expect(consentForm(html).resources).toEqual([`${world.mcpBase}/${slug}`]);
    expect(html).toContain('user12@acme.example');
  },
);

Then('user {int} is asked for a code from their authenticator app, and sees no consent yet', (world: SynoikiaWorld) => {
  const { signIn, page } = flowOf(world);
  expect(signIn!.html).toContain('<h1>Two-factor code</h1>');
  expect(signIn!.html).toContain('name="mfa"');
  expect(page!.html).not.toContain('Authorize');
});

Then('user {int} is told to set up their authenticator app in the portal first', (world: SynoikiaWorld) => {
  const { signIn, page } = flowOf(world);
  expect(signIn!.status).toBe(403);
  expect(signIn!.html).toContain('Set up your authenticator app in the admin portal (Profile) first.');
  expect(page!.html).not.toContain('Authorize');
});

Then(
  'user {int} is offered {string} and not {string}',
  (world: SynoikiaWorld, _user: number, offered: string, hidden: string) => {
    const { html } = flowOf(world).page!;
    expect(consentForm(html).resources).toEqual([`${world.mcpBase}/${offered}`]);
    expect(html).not.toContain(`/${hidden}`);
  },
);

Then(
  'user {int} is told that none of the requested instances is available to their account',
  (world: SynoikiaWorld) => {
    const page = flowOf(world).page!;
    expect(page.status).toBe(403);
    expect(page.html).toContain('None of the requested endpoints is available to your account.');
    expect(page.location ?? null).toBeNull();
  },
);

When(
  'user {int} opens the sign-in of {string} and signs in with an Acme ID that no account has',
  async (world: SynoikiaWorld, user: number, name: string) => {
    const flow = flowFor(app(world, name));
    flow.browser = world.pageBrowser();
    clientAuth(world).flow = flow;
    (await world.acmeId()).next = world.acmeIdentityOf(person(user));
    const path = `/oauth/authorize?${flow.query.toString()}`;
    const end = await world.follow(flow.browser, `/oauth/login/oidc?continue=${encodeURIComponent(path)}`);
    flow.page = { status: end.status, html: end.html };
  },
);

Then('user {int} is told that their account is not allowed to sign in here', (world: SynoikiaWorld) => {
  const page = flowOf(world).page!;
  expect(page.status).toBe(403);
  expect(page.html).toContain('Your account is not allowed to sign in here.');
});

When('user {int} approves with no instance picked', async (world: SynoikiaWorld) => {
  await decide(world, flowOf(world), 'approve', { slugs: [] });
});

Then('user {int} is asked to pick at least one instance, or to deny', (world: SynoikiaWorld) => {
  const flow = flowOf(world);
  expect(flow.page!.status).toBe(200);
  expect(flow.page!.html).toContain('Pick at least one endpoint, or deny.');
  expect(flow.code).toBeUndefined();
});

When('user {int} denies the request of {string}', async (world: SynoikiaWorld) => {
  await decide(world, flowOf(world), 'deny');
});

Then(
  '{string} is told that access was denied, and the audit log shows the denial by user {int}',
  async (world: SynoikiaWorld, name: string, user: number) => {
    const back = new URL(flowOf(world).page!.location!);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('acme-chat');
    const rows = await auditRows(world, { decision: 'oauth_consent_denied' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: world.person(person(user)).id,
      detail: { clientId: app(world, name).clientId },
    });
  },
);

Given(
  'user {int} let agent {word} in through {string} with the access that the page offers',
  async (world: SynoikiaWorld, user: number, agent: string) => {
    await oauthSignIn(world, agent, person(user));
  },
);

Given(
  'user {int} let agent {word} in through {string} with read and write',
  async (world: SynoikiaWorld, user: number, agent: string) => {
    await oauthSignIn(world, agent, person(user), { access: 'write' });
  },
);

Given('agent {word} renews its sign-in', async (world: SynoikiaWorld, agent: string) => {
  const renewed = await world.renewOAuth(agent);
  expect(renewed.status).toBe(200);
  const a = world.agents.get(agent)!;
  await a.client?.close().catch(() => undefined);
  world.agents.set(agent, {
    ...a,
    client: undefined,
    transport: undefined,
    token: renewed.body.access_token as string,
    oauth: { ...a.oauth!, refreshToken: renewed.body.refresh_token as string },
  });
});

When('the consent form of user {int} is sent from another browser', async (world: SynoikiaWorld, user: number) => {
  const flow = flowOf(world);
  const other: Flow = { ...flow, browser: world.pageBrowser() };
  await world.signInOnPage(other.browser!.send, person(user), `/oauth/authorize?${flow.query.toString()}`);
  await decide(world, other, 'approve');
  clientAuth(world).flow = other;
});

When('user {int} approves the request of {string}', async (world: SynoikiaWorld) => {
  await decide(world, flowOf(world), 'approve');
});

Then("the page says that the session expired, and to start again from the agent's app", (world: SynoikiaWorld) => {
  const flow = flowOf(world);
  expect(flow.page!.html).toContain('<h1>Session expired</h1>');
  expect(flow.page!.html).toContain('Start the connection again from your MCP client.');
  expect(flow.code).toBeUndefined();
});

Given(
  'user {int} may add tasks to {string} without a question',
  async (world: SynoikiaWorld, _user: number, slug: string) => {
    await world.setGroupLevel(slug, 'tasks', 'write');
    await world.setRoleMaximum('family', slug, { group: 'tasks' }, 'write');
  },
);
