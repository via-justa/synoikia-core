import { describe, expect, it } from 'vitest';
import { allowedLevels, effectiveAccess, levelInForce, normalizeLevel } from '../src/gate/access.js';
import type { AccessLevel, AccessOperation } from '../src/gate/access.js';

const read: AccessOperation = { classification: 'read', locked: false, levelOverride: null, writeAcknowledged: false };
const write: AccessOperation = { ...read, classification: 'write', writeAcknowledged: true };
const locked: AccessOperation = { ...write, locked: true };

const at = (level: AccessLevel) => ({ level });
const readOnly = { ceiling: 'read' as const, roleId: 'admin' };

describe('effectiveAccess', () => {
  it.each([
    // [name, op, group level, expected]
    ['read op, none', read, 'none', { reachable: false, reason: 'level_none' }],
    ['read op, read', read, 'read', { reachable: true, mode: 'run', level: 'read' }],
    // A group at Ask or Write still lets its reads run; only a read's own Ask makes it ask.
    ['read op, ask', read, 'ask', { reachable: true, mode: 'run', level: 'read' }],
    ['read op, write', read, 'write', { reachable: true, mode: 'run', level: 'read' }],
    ['write op, none', write, 'none', { reachable: false, reason: 'level_none' }],
    // There is no "write at level Read": the write is simply off.
    ['write op, read', write, 'read', { reachable: false, reason: 'level_none' }],
    ['write op, ask', write, 'ask', { reachable: true, mode: 'approve', level: 'ask' }],
    ['write op, write', write, 'write', { reachable: true, mode: 'auto', level: 'write' }],
    ['locked op, none', locked, 'none', { reachable: false, reason: 'level_none' }],
    ['locked op, read', locked, 'read', { reachable: false, reason: 'locked_not_opted_in' }],
    ['locked op, ask (group only)', locked, 'ask', { reachable: false, reason: 'locked_not_opted_in' }],
    ['locked op, write (group only)', locked, 'write', { reachable: false, reason: 'locked_not_opted_in' }],
  ] as const)('%s', (_name, op, level, expected) => {
    expect(effectiveAccess(op, at(level))).toEqual(expected);
  });

  it('fails closed when the group row is missing or has an unknown level', () => {
    expect(effectiveAccess(read, undefined)).toEqual({ reachable: false, reason: 'group_missing' });
    expect(effectiveAccess(read, { level: 'admin' as AccessLevel })).toEqual({
      reachable: false,
      reason: 'group_missing',
    });
    // An unknown override is treated as None, never as "follow the group".
    expect(effectiveAccess({ ...read, levelOverride: 'admin' as AccessLevel }, at('write'))).toEqual({
      reachable: false,
      reason: 'level_none',
    });
  });

  it('lets an operation’s own level win over its group, in both directions', () => {
    expect(effectiveAccess({ ...write, levelOverride: 'none' }, at('write'))).toEqual({
      reachable: false,
      reason: 'level_none',
    });
    expect(effectiveAccess({ ...write, levelOverride: 'write' }, at('read'))).toEqual({
      reachable: true,
      mode: 'auto',
      level: 'write',
    });
    expect(effectiveAccess({ ...write, levelOverride: 'ask' }, at('write'))).toEqual({
      reachable: true,
      mode: 'approve',
      level: 'ask',
    });
    expect(effectiveAccess({ ...read, levelOverride: 'read' }, at('none'))).toEqual({
      reachable: true,
      mode: 'run',
      level: 'read',
    });
  });

  it('opens a locked op only with its own Ask, and always asks', () => {
    // The operation's own level wins, even over a group at None.
    expect(effectiveAccess({ ...locked, levelOverride: 'ask' }, at('none'))).toEqual({
      reachable: true,
      mode: 'approve',
      level: 'ask',
    });
    expect(effectiveAccess({ ...locked, levelOverride: 'ask' }, at('read'))).toEqual({
      reachable: true,
      mode: 'approve',
      level: 'ask',
    });
    // `write` is refused at the API; even if a row carried it, a locked op never auto-approves.
    expect(effectiveAccess({ ...locked, levelOverride: 'write' }, at('write'))).toEqual({
      reachable: true,
      mode: 'approve',
      level: 'ask',
    });
    // A stored Read doesn't fit a locked op: it is None.
    expect(effectiveAccess({ ...locked, levelOverride: 'read' }, at('write'))).toEqual({
      reachable: false,
      reason: 'level_none',
    });
  });

  it('makes a read with its own Ask need approval, even for a read-only connection', () => {
    expect(effectiveAccess({ ...read, levelOverride: 'ask' }, at('read'))).toEqual({
      reachable: true,
      mode: 'approve',
      level: 'ask',
    });
    expect(effectiveAccess({ ...read, levelOverride: 'ask' }, at('write'), readOnly)).toMatchObject({
      mode: 'approve',
    });
  });

  it('offers each kind only the levels that mean something for it', () => {
    expect(allowedLevels(read)).toEqual(['none', 'read', 'ask']);
    expect(allowedLevels(write)).toEqual(['none', 'ask', 'write']);
    expect(allowedLevels(locked)).toEqual(['none', 'ask']);
  });

  it('narrows a stored level that does not fit, never widening it', () => {
    expect(normalizeLevel(read, 'write')).toBe('read');
    expect(normalizeLevel(write, 'read')).toBe('none');
    expect(normalizeLevel(locked, 'read')).toBe('none');
    expect(normalizeLevel(locked, 'write')).toBe('ask');
    expect(normalizeLevel(write, 'bogus')).toBe('none');
    expect(normalizeLevel(write, 'ask')).toBe('ask');
  });

  it('reports the level in force in the operation’s own terms', () => {
    expect(levelInForce(read, at('ask'))).toBe('read');
    expect(levelInForce(write, at('read'))).toBe('none');
    expect(levelInForce(write, at('write'))).toBe('write');
    expect(levelInForce(locked, at('write'))).toBe('none');
    expect(levelInForce({ ...locked, levelOverride: 'ask' }, at('none'))).toBe('ask');
    expect(levelInForce(read, undefined)).toBe('none');
  });

  it('treats a locked op as a write even if its row says read', () => {
    expect(effectiveAccess({ ...locked, classification: 'read' }, at('write'))).toEqual({
      reachable: false,
      reason: 'locked_not_opted_in',
    });
  });

  it('asks for unacknowledged writes at Write until someone acknowledges them', () => {
    expect(effectiveAccess({ ...write, writeAcknowledged: false }, at('write'))).toEqual({
      reachable: true,
      mode: 'approve',
      level: 'write',
      pendingReview: true,
    });
    expect(effectiveAccess({ ...write, writeAcknowledged: false }, at('ask'))).toEqual({
      reachable: true,
      mode: 'approve',
      level: 'ask',
    });
  });

  it('caps a read-only principal at reads, whatever the levels say', () => {
    expect(effectiveAccess(read, at('write'), readOnly)).toMatchObject({ reachable: true, mode: 'run' });
    for (const op of [write, { ...locked, levelOverride: 'ask' as const }]) {
      for (const level of ['ask', 'write'] as const) {
        expect(effectiveAccess(op, at(level), readOnly)).toEqual({ reachable: false, reason: 'token_read_only' });
      }
    }
    expect(effectiveAccess(write, at('none'), readOnly)).toEqual({ reachable: false, reason: 'level_none' });
  });
});
