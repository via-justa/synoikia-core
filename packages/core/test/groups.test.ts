import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  applyBulkLevel,
  listGroups,
  listOperations,
  mergeGroups,
  renameGroup,
  resolveAccess,
  setGroupLevel,
  updateGroup,
  updateOperation,
} from '../src/catalog/groups.js';
import { applyCatalogSync } from '../src/catalog/sync.js';
import { createRule, updateRule } from '../src/catalog/rules.js';
import { evaluatePreApproval } from '../src/gate/preapproval.js';
import { auditLog, operationGroupAliases, operations, preApprovalRules } from '../src/db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../src/errors.js';
import { catalog, op, seedInstance } from './helpers.js';

function setup() {
  const ctx = seedInstance();
  applyCatalogSync(
    ctx.db,
    ctx.instanceId,
    catalog(
      op('app.query'),
      op('app.upgrade'),
      op('app.stop'),
      op('app.delete', { locked: true }),
      op('store.query'),
      op('store.volume.create'),
    ),
  );
  const id = (key: string) => ctx.db.select().from(operations).where(eq(operations.key, key)).get()!.id;
  return { ...ctx, id };
}

describe('setGroupLevel', () => {
  it('raises to Write without a confirmation, acknowledging the writes it lets run', () => {
    const { db, instanceId } = setup();
    const group = setGroupLevel(db, instanceId, 'app', 'write', { actor: { userId: undefined } });
    expect(group).toMatchObject({
      level: 'write',
      counts: { read: 1, write: 2, locked: 1, pendingReview: 0, overridden: 0 },
    });
    expect(resolveAccess(db, instanceId, 'app.upgrade')).toEqual({ reachable: true, mode: 'auto', level: 'write' });
    expect(resolveAccess(db, instanceId, 'app.delete')).toEqual({ reachable: false, reason: 'locked_not_opted_in' });
    const event = db
      .select()
      .from(auditLog)
      .all()
      .find((a) => a.decision === 'group_level_changed');
    expect(event?.detail).toMatchObject({ to: 'write', acknowledged: ['app.stop', 'app.upgrade'] });
  });

  it('lowers levels without acknowledgement and audits every change', () => {
    const { db, instanceId } = setup();
    setGroupLevel(db, instanceId, 'app', 'none');
    expect(resolveAccess(db, instanceId, 'app.query')).toEqual({ reachable: false, reason: 'level_none' });
    const audit = db
      .select()
      .from(auditLog)
      .all()
      .filter((a) => a.decision === 'group_level_changed');
    expect(audit[0]?.detail).toEqual({ group: 'app', from: 'ask', to: 'none', acknowledged: [], reset: [] });
  });

  it('rejects unknown groups and levels', () => {
    const { db, instanceId } = setup();
    expect(() => setGroupLevel(db, instanceId, 'nope', 'read')).toThrow(NotFoundError);
    expect(() => setGroupLevel(db, instanceId, 'app', 'admin')).toThrow(ValidationError);
  });
});

describe('bulk levels', () => {
  it('sets every group to Write without a confirmation, and leaves locked ops off', () => {
    const { db, instanceId } = setup();
    applyCatalogSync(
      db,
      instanceId,
      catalog(
        op('app.query'),
        op('app.upgrade'),
        op('app.stop'),
        op('app.delete', { locked: true }),
        op('store.query'),
        op('store.volume.create'),
        op('store.export'),
      ),
    );
    expect(applyBulkLevel(db, instanceId, 'write').map((g) => [g.key, g.from])).toEqual([
      ['app', 'ask'],
      ['store', 'ask'],
      ['store.volume', 'ask'],
    ]);
    expect(listGroups(db, instanceId).every((g) => g.level === 'write')).toBe(true);
    expect(resolveAccess(db, instanceId, 'store.export')).toMatchObject({ reachable: true, mode: 'auto' });
    expect(resolveAccess(db, instanceId, 'app.delete')).toEqual({ reachable: false, reason: 'locked_not_opted_in' });
    const event = db
      .select()
      .from(auditLog)
      .all()
      .find((a) => a.decision === 'group_level_bulk_changed');
    // store.export arrived as its own None; setting every group resets it to follow, so Write runs it.
    expect(event?.detail).toMatchObject({
      to: 'write',
      groups: [{ key: 'app', from: 'ask', to: 'write' }, {}, {}],
      acknowledged: ['app.stop', 'app.upgrade', 'store.export', 'store.volume.create'],
      reset: ['store.export'],
    });
  });

  it('applies all → none / read / ask', () => {
    const { db, instanceId } = setup();
    for (const level of ['none', 'read', 'ask'] as const) {
      applyBulkLevel(db, instanceId, level);
      expect(listGroups(db, instanceId).every((g) => g.level === level)).toBe(true);
    }
    expect(resolveAccess(db, instanceId, 'app.upgrade')).toEqual({ reachable: true, mode: 'approve', level: 'ask' });
  });
});

describe('listOperations and updateGroup', () => {
  it('filters operations by group, reason, text and staleness', () => {
    const { db, instanceId, id } = setup();
    const keys = (filter: Parameters<typeof listOperations>[2]) =>
      listOperations(db, instanceId, filter).map((o) => o.key);
    expect(keys({ group: 'store' })).toEqual(['store.query']);
    expect(keys({ q: 'VOLUME' })).toEqual(['store.volume.create']);
    setGroupLevel(db, instanceId, 'store', 'none');
    expect(keys({ reason: 'level_none' })).toEqual(['store.query']);
    expect(listOperations(db, instanceId).find((o) => o.id === id('app.query'))).toMatchObject({
      group: 'app',
      reachable: true,
      reason: null,
    });
    applyCatalogSync(db, instanceId, catalog(op('app.query')));
    expect(keys({})).toEqual(['app.query']);
    expect(keys({ stale: '1' })).toHaveLength(6);
  });

  it('renames and sets the level of a group, and returns it', () => {
    const { db, instanceId } = setup();
    expect(updateGroup(db, instanceId, 'app', { label: 'Apps', level: 'read' })).toMatchObject({
      key: 'app',
      label: 'Apps',
      level: 'read',
    });
    expect(updateGroup(db, instanceId, 'app', {})).toMatchObject({ label: 'Apps' });
    expect(() => updateGroup(db, instanceId, 'nope', { label: 'X' })).toThrow(NotFoundError);
  });
});

describe('updateOperation', () => {
  it('gives an operation its own level, which wins over its group until the group is set again', () => {
    const { db, instanceId, id } = setup();
    setGroupLevel(db, instanceId, 'app', 'write');
    updateOperation(db, instanceId, id('app.stop'), { level: 'none' });
    expect(resolveAccess(db, instanceId, 'app.stop')).toEqual({ reachable: false, reason: 'level_none' });
    expect(listGroups(db, instanceId).find((g) => g.key === 'app')?.counts.overridden).toBe(1);

    // Upward too: one write can run without asking while the rest of its group asks.
    setGroupLevel(db, instanceId, 'app', 'ask');
    updateOperation(db, instanceId, id('app.stop'), { level: 'write' });
    expect(resolveAccess(db, instanceId, 'app.stop')).toEqual({ reachable: true, mode: 'auto', level: 'write' });
    expect(resolveAccess(db, instanceId, 'app.upgrade')).toMatchObject({ mode: 'approve', level: 'ask' });

    updateOperation(db, instanceId, id('app.stop'), { level: null });
    expect(resolveAccess(db, instanceId, 'app.stop')).toMatchObject({ mode: 'approve', level: 'ask' });

    // Setting the group's level again resets every operation in it to follow, and says which.
    updateOperation(db, instanceId, id('app.stop'), { level: 'none' });
    updateOperation(db, instanceId, id('app.query'), { level: 'ask' });
    setGroupLevel(db, instanceId, 'app', 'ask');
    expect(resolveAccess(db, instanceId, 'app.stop')).toMatchObject({ mode: 'approve', level: 'ask' });
    expect(resolveAccess(db, instanceId, 'app.query')).toMatchObject({ mode: 'run', level: 'read' });
    expect(listGroups(db, instanceId).find((g) => g.key === 'app')?.counts.overridden).toBe(0);
    const last = db
      .select()
      .from(auditLog)
      .all()
      .filter((a) => a.decision === 'group_level_changed')
      .at(-1);
    expect(last?.detail).toMatchObject({ from: 'ask', to: 'ask', reset: ['app.query', 'app.stop'] });
  });

  it('makes a read with its own Ask need approval while its group lets other reads run', () => {
    const { db, instanceId, id } = setup();
    updateOperation(db, instanceId, id('app.query'), { level: 'ask' });
    expect(resolveAccess(db, instanceId, 'app.query')).toEqual({ reachable: true, mode: 'approve', level: 'ask' });
    expect(resolveAccess(db, instanceId, 'store.query')).toEqual({ reachable: true, mode: 'run', level: 'read' });
  });

  it('opens a locked operation only with its own Ask, and never lets it auto-run', () => {
    const { db, instanceId, id } = setup();
    setGroupLevel(db, instanceId, 'app', 'write');
    expect(resolveAccess(db, instanceId, 'app.delete')).toEqual({ reachable: false, reason: 'locked_not_opted_in' });
    expect(() => updateOperation(db, instanceId, id('app.delete'), { level: 'write' })).toThrow(ConflictError);
    updateOperation(db, instanceId, id('app.delete'), { level: 'ask' });
    expect(resolveAccess(db, instanceId, 'app.delete')).toEqual({ reachable: true, mode: 'approve', level: 'ask' });
    // Setting the group again closes it: it needs its own Ask again.
    setGroupLevel(db, instanceId, 'app', 'read');
    expect(resolveAccess(db, instanceId, 'app.delete')).toEqual({ reachable: false, reason: 'locked_not_opted_in' });
  });

  it('only accepts the levels an operation’s kind allows, and has no classification override', () => {
    const { db, instanceId, id } = setup();
    expect(() => updateOperation(db, instanceId, id('app.query'), { level: 'write' })).toThrow(
      /must be one of none, read, ask/,
    );
    expect(() => updateOperation(db, instanceId, id('app.stop'), { level: 'read' })).toThrow(
      /must be one of none, ask, write/,
    );
    expect(() => updateOperation(db, instanceId, id('app.delete'), { level: 'read' })).toThrow(ValidationError);
    expect(() => updateOperation(db, instanceId, 'nope', { level: 'none' })).toThrow(NotFoundError);
    expect(() => updateOperation(db, instanceId, id('app.stop'), { level: 'admin' as 'none' })).toThrow(
      ValidationError,
    );
    // A stray classification field is ignored, not applied.
    updateOperation(db, instanceId, id('app.query'), { classification: 'write' } as never);
    expect(db.select().from(operations).where(eq(operations.key, 'app.query')).get()?.classification).toBe('read');
  });

  it('treats its own Write level as acknowledgement', () => {
    const { db, instanceId, id } = setup();
    updateOperation(db, instanceId, id('store.volume.create'), { level: 'write' });
    expect(resolveAccess(db, instanceId, 'store.volume.create')).toMatchObject({ mode: 'auto' });
  });

  it('keeps writes found by a later sync off until an admin opens them', () => {
    const { db, instanceId } = setup();
    setGroupLevel(db, instanceId, 'app', 'write');
    applyCatalogSync(
      db,
      instanceId,
      catalog(
        op('app.query'),
        op('app.upgrade'),
        op('app.stop'),
        op('app.delete', { locked: true }),
        op('app.redeploy'),
        op('store.query'),
        op('store.volume.create'),
      ),
    );
    expect(resolveAccess(db, instanceId, 'app.redeploy')).toEqual({ reachable: false, reason: 'level_none' });
    // Setting the group to Write again resets it to follow, and acknowledges it with the rest.
    setGroupLevel(db, instanceId, 'app', 'write');
    expect(resolveAccess(db, instanceId, 'app.redeploy')).toMatchObject({ mode: 'auto' });
  });
});

describe('re-sync of changed operations (review M14)', () => {
  const profiles = { byName: [{ field: '/name', label: 'Name', widget: 'text' as const, op: 'eq' as const }] };
  const all = (extra: Parameters<typeof op>[1] = {}, drop = false) =>
    catalog(
      op('app.query'),
      op('app.upgrade', { matchProfile: 'byName', paramsSchema: { type: 'object' }, ...extra }),
      op('app.stop'),
      op('app.delete', { locked: true }),
      op('store.query'),
      ...(drop ? [] : [op('store.volume.create')]),
    );

  it('asks again when an acknowledged write changes or returns from stale, not on a plain re-sync', () => {
    const { db, instanceId, id } = setup();
    applyCatalogSync(db, instanceId, all());
    setGroupLevel(db, instanceId, 'app', 'write');
    setGroupLevel(db, instanceId, 'store.volume', 'write');

    expect(applyCatalogSync(db, instanceId, all()).pendingReview).toEqual([]);
    expect(resolveAccess(db, instanceId, 'app.upgrade')).toMatchObject({ mode: 'auto' });

    const changed = applyCatalogSync(db, instanceId, all({ paramsSchema: { type: 'object', required: ['force'] } }));
    expect(changed.pendingReview).toEqual(['app.upgrade']);
    expect(resolveAccess(db, instanceId, 'app.upgrade')).toMatchObject({ mode: 'approve', pendingReview: true });
    expect(resolveAccess(db, instanceId, 'app.stop')).toMatchObject({ mode: 'auto' });

    updateOperation(db, instanceId, id('app.upgrade'), { acknowledged: true });
    expect(applyCatalogSync(db, instanceId, all({ kind: 'endpoint' })).pendingReview).toEqual(['app.upgrade']);

    applyCatalogSync(db, instanceId, all({ kind: 'endpoint' }, true));
    const back = applyCatalogSync(db, instanceId, all({ kind: 'endpoint' }));
    expect(back.pendingReview).toContain('store.volume.create');
    expect(resolveAccess(db, instanceId, 'store.volume.create')).toMatchObject({
      mode: 'approve',
      pendingReview: true,
    });
  });

  it('lets an admin turn the attestation requirement off, and remembers it across syncs (review L13)', () => {
    const { db, instanceId, id } = setup();
    const guided = () => catalog(op('app.query'), op('app.upgrade', { attestationRequired: true }));
    applyCatalogSync(db, instanceId, guided());
    const row = () => db.select().from(operations).where(eq(operations.key, 'app.upgrade')).get()!;
    expect(row().attestationRequired).toBe(true);

    updateOperation(db, instanceId, id('app.upgrade'), { attestationRequired: false }, { actor: { userId: 'u1' } });
    applyCatalogSync(db, instanceId, guided());
    expect(row().attestationRequired).toBe(false);
    const audit = db
      .select()
      .from(auditLog)
      .all()
      .filter((a) => a.decision === 'operation_updated')
      .at(-1);
    expect(audit).toMatchObject({ actorId: 'u1', detail: { after: { attestationRequired: false } } });

    updateOperation(db, instanceId, id('app.upgrade'), { attestationRequired: true });
    applyCatalogSync(db, instanceId, guided());
    expect(row().attestationRequired).toBe(true);
  });

  it('always requires typed confirmation on locked operations (review M15)', () => {
    const { db, instanceId } = setup();
    applyCatalogSync(
      db,
      instanceId,
      catalog(op('app.delete', { locked: true, typedConfirmation: false }), op('app.stop')),
    );
    const row = (key: string) => db.select().from(operations).where(eq(operations.key, key)).get()!;
    expect(row('app.delete').typedConfirmation).toBe(true);
    expect(row('app.stop').typedConfirmation).toBe(false);
  });

  it('disables rules whose match no longer fits the operation, and audits it', () => {
    const { db, instanceId, id } = setup();
    applyCatalogSync(db, instanceId, all(), new Date(), { matchProfiles: profiles });
    const targets = { label: 'Widget', scopes: [{ key: 'zone', label: 'Zone' }] };
    const manifest = { matchProfiles: profiles, targets } as never;
    const fits = createRule(db, manifest, instanceId, {
      operationId: id('app.upgrade'),
      match: [{ field: '/name', op: 'eq', value: 'web' }],
      reason: 'routine upgrades',
    });
    const anyOnly = createRule(db, manifest, instanceId, {
      operationId: id('app.upgrade'),
      match: [{ field: '', op: 'any' }],
      reason: 'any upgrade',
    });

    // Same profile: nothing changes.
    expect(applyCatalogSync(db, instanceId, all(), new Date(), { matchProfiles: profiles }).rulesDisabled).toBe(0);

    // The plugin dropped the profile: the field-based rule is disabled, the "any" rule still fits.
    const summary = applyCatalogSync(db, instanceId, all({ matchProfile: undefined }), new Date(), {
      matchProfiles: profiles,
    });
    expect(summary.rulesDisabled).toBe(1);
    const enabled = (ruleId: string) =>
      db.select().from(preApprovalRules).where(eq(preApprovalRules.id, ruleId)).get()!.enabled;
    expect(enabled(fits.id)).toBe(false);
    expect(enabled(anyOnly.id)).toBe(true);
    const audit = db
      .select()
      .from(auditLog)
      .all()
      .find((a) => a.decision === 'rules_disabled_operation_changed');
    expect(audit?.detail).toMatchObject({ rules: [{ ruleId: fits.id, operationKey: 'app.upgrade' }] });
  });
});

describe('rules on $targets (design §3.4)', () => {
  const profiles = {
    targets: [
      { field: '$targets', label: 'Targets', widget: 'registry-picker' as const, covers: ['/selector'] },
      { field: '/level', label: 'Level', widget: 'range' as const, op: 'range' as const },
    ],
  };
  const targets = { label: 'Widget', scopes: [{ key: 'zone', label: 'Zone' }] };
  const manifest = { matchProfiles: profiles, targets } as never;
  const target = (id: string, area: string) => ({ kind: 'entity', id, name: id, scopes: { zone: area } });
  const inZoneA = [target('widget.one', 'zone-a')];

  function withRules() {
    const ctx = setup();
    applyCatalogSync(
      ctx.db,
      ctx.instanceId,
      catalog(op('app.upgrade', { matchProfile: 'targets' }), op('app.stop', { matchProfile: 'targets' })),
      new Date(),
      { matchProfiles: profiles, targets } as never,
    );
    const areaRule = createRule(ctx.db, manifest, ctx.instanceId, {
      operationId: ctx.id('app.upgrade'),
      match: [{ field: '$targets', scopes: { zone: ['zone-a'] } }],
      reason: 'widgets in zone A',
    });
    const anyTarget = createRule(ctx.db, manifest, ctx.instanceId, {
      operationId: ctx.id('app.stop'),
      match: [
        { field: '/selector', op: 'any' },
        { field: '/level', op: 'range', value: { max: 50 } },
      ],
      reason: 'low level on anything',
    });
    const evaluate = (key: string, params: unknown, targets: ReturnType<typeof target>[], targetCovers?: string[]) =>
      evaluatePreApproval(ctx.db, {
        instanceId: ctx.instanceId,
        operationId: ctx.id(key),
        params,
        targets,
        targetCovers,
      });
    return { ...ctx, areaRule, anyTarget, evaluate };
  }

  it('stores a rule exactly as written, with no hidden conditions', () => {
    const { areaRule, anyTarget, db, instanceId } = withRules();
    expect(areaRule.match).toEqual([{ field: '$targets', scopes: { zone: ['zone-a'] } }]);
    // An explicit "any target" without a $targets condition is the admin's choice, and is kept.
    expect(anyTarget.match).toEqual([
      { field: '/selector', op: 'any' },
      { field: '/level', op: 'range', value: { max: 50 } },
    ]);
    const updated = updateRule(db, manifest, instanceId, areaRule.id, {
      match: [{ field: '$targets', scopes: { zone: ['zone-b'] } }],
    });
    expect(updated.match).toEqual([{ field: '$targets', scopes: { zone: ['zone-b'] } }]);
    // Only the scopes the plugin declares can be selected.
    expect(() =>
      updateRule(db, manifest, instanceId, areaRule.id, { match: [{ field: '$targets', scopes: { floor: ['1'] } }] }),
    ).toThrow(/can't select targets by "floor"/);
  });

  it('lets a $targets condition cover the raw selector at match time, never widening the target check', () => {
    const { evaluate } = withRules();
    const params = { selector: { zone: ['zone-a'] } };
    expect(evaluate('app.upgrade', params, inZoneA, ['/selector'])).toMatchObject({ kind: 'auto_approved' });
    // Without the profile's covers pointer, the raw selector is an uncovered param under strict matching.
    expect(evaluate('app.upgrade', params, inZoneA)).toEqual({ kind: 'no_match' });
    // One target outside the area still asks.
    expect(evaluate('app.upgrade', params, [...inZoneA, target('widget.two', 'zone-b')], ['/selector'])).toEqual({
      kind: 'no_match',
    });
    // Other params still need their own condition.
    expect(evaluate('app.upgrade', { ...params, level: 10 }, inZoneA, ['/selector'])).toEqual({ kind: 'no_match' });
    // A selector spread over several params is covered when the profile names every subtree.
    const split = { ...params, host: { id: 'h1' } };
    expect(evaluate('app.upgrade', split, inZoneA, ['/selector', '/host'])).toMatchObject({ kind: 'auto_approved' });
    expect(evaluate('app.upgrade', split, inZoneA, ['/selector'])).toEqual({ kind: 'no_match' });
  });

  it('applies an explicit "any target" rule on its own terms', () => {
    const { evaluate } = withRules();
    expect(
      evaluate(
        'app.stop',
        { selector: { zone: ['zone-b'] }, level: 40 },
        [target('widget.two', 'zone-b')],
        ['/selector'],
      ),
    ).toMatchObject({ kind: 'auto_approved' });
    expect(
      evaluate(
        'app.stop',
        { selector: { zone: ['zone-b'] }, level: 90 },
        [target('widget.two', 'zone-b')],
        ['/selector'],
      ),
    ).toEqual({ kind: 'no_match' });
  });
});

describe('regrouping', () => {
  it('merges into the lowest level, keeps aliases, and survives re-sync', () => {
    const { db, instanceId } = setup();
    setGroupLevel(db, instanceId, 'store', 'none');
    setGroupLevel(db, instanceId, 'store.volume', 'write');

    const merged = mergeGroups(db, instanceId, { from: ['store.volume'], into: 'store', label: 'Storage' });
    expect(merged).toMatchObject({ key: 'store', label: 'Storage', level: 'none' });
    expect(db.select().from(operationGroupAliases).all()).toEqual([
      { instanceId, pluginGroup: 'store.volume', groupKey: 'store' },
    ]);
    expect(listGroups(db, instanceId).map((g) => g.key)).toEqual(['app', 'store']);
  });

  it('merges into a brand-new group and repoints existing aliases', () => {
    const { db, instanceId } = setup();
    mergeGroups(db, instanceId, { from: ['store.volume'], into: 'store' });
    mergeGroups(db, instanceId, { from: ['store'], into: 'storage' });
    expect(
      new Set(
        db
          .select()
          .from(operationGroupAliases)
          .all()
          .map((a) => `${a.pluginGroup}->${a.groupKey}`),
      ),
    ).toEqual(new Set(['store.volume->storage', 'store->storage']));
    applyCatalogSync(db, instanceId, catalog(op('store.query'), op('store.volume.create'), op('app.query')));
    expect(listGroups(db, instanceId).map((g) => g.key)).toEqual(['app', 'storage']);
  });

  it('validates merge input and renames labels', () => {
    const { db, instanceId } = setup();
    expect(() => mergeGroups(db, instanceId, { from: ['app'], into: 'app' })).toThrow(ValidationError);
    expect(() => mergeGroups(db, instanceId, { from: ['app'], into: 'Bad Key' })).toThrow(ValidationError);
    renameGroup(db, instanceId, 'app', 'Apps');
    expect(listGroups(db, instanceId).find((g) => g.key === 'app')?.label).toBe('Apps');
    expect(() => renameGroup(db, instanceId, 'app', '  ')).toThrow(ValidationError);
  });
});
