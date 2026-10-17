import { Given, Then, When } from 'quickpickle';
import { expect } from 'vitest';
import { opKey } from '../../support/world.js';
import type { SynoikiaWorld } from '../../support/world.js';

Given(
  'user {int} has the role {string}, which has the instance {string}',
  async (world: SynoikiaWorld, user: number, role: string, slug: string) => {
    await world.user(`user ${user}`, role);
    await world.setRoleInstances(role, [slug]);
  },
);

Given(
  'the role {string} lets its users set their own levels on {string}',
  async (world: SynoikiaWorld, role: string, slug: string) => {
    await world.setRoleSwitches(role, slug, { canSetOwnLevels: true });
  },
);

Given(
  'agent {word} belongs to user {int} and may read and write',
  async (world: SynoikiaWorld, agent: string, user: number) => {
    await world.credential(agent, `user ${user}`, 'write');
  },
);

Given(
  'user {int} gave agent {word} a read-only credential instead',
  async (world: SynoikiaWorld, user: number, agent: string) => {
    await world.credential(agent, `user ${user}`, 'read');
  },
);

Given(
  'the admin sets the maximum of {string} for the group {string} to {word}',
  async (world: SynoikiaWorld, role: string, group: string, level: string) => {
    await world.setRoleMaximum(role, world.lastInstance, { group }, level);
  },
);

Given(
  'the admin sets the maximum of {string} for {string} to {word}',
  async (world: SynoikiaWorld, role: string, name: string, level: string) => {
    await world.setRoleMaximum(role, world.lastInstance, { op: name }, level);
  },
);

Given(
  'the role {string} has no maximum for the group {string}',
  async (world: SynoikiaWorld, role: string, group: string) => {
    await world.setRoleMaximum(role, world.lastInstance, { group }, null);
  },
);

Given(
  'the admin takes the instance {string} out of the role {string}',
  async (world: SynoikiaWorld, _slug: string, role: string) => {
    await world.setRoleInstances(role, []);
  },
);

Given(
  'user {int} sets their own level of {string} to {word}',
  async (world: SynoikiaWorld, user: number, name: string, level: string) => {
    await world.setOwnLevel(`user ${user}`, world.lastInstance, name, level);
  },
);

Given('the admin disables user {int}', async (world: SynoikiaWorld, user: number) => {
  const { id } = world.person(`user ${user}`);
  await world.expectOk(world.admin.patch(`/api/users/${id}`, { disabled: true }), 'disable user');
});

When(
  'user {int} tries to set their own level of {string} to {word}',
  async (world: SynoikiaWorld, user: number, name: string, level: string) => {
    await world.setOwnLevel(`user ${user}`, world.lastInstance, name, level, 'refused');
  },
);

Then(
  'user {int} is told that their role allows at most {word} for {string}',
  (world: SynoikiaWorld, _user: number, level: string, name: string) => {
    expect(world.portalAnswer.body).toMatchObject({
      message: `Your role allows at most ${level} for ${opKey(name)}`,
    });
  },
);

Then(
  'agent {word} is told that {string} is not available to its role',
  (world: SynoikiaWorld, _agent: string, _slug: string) => {
    expect(world.answer.refused).toMatch(/not available to your role/);
  },
);

Then('agent {word} is refused, and gets no tasks', (world: SynoikiaWorld) => {
  expect(world.answer.refused).toMatch(/Invalid or expired token/);
});
