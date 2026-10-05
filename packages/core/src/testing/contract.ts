import type { AccessLevel } from '../gate/access.js';
import type { PluginHarness } from './index.js';

/** The end-to-end checks every plugin repeats (read, refused write, locked with literal, secrets kept
 * out, audit): `expect(await checkPluginContract(h, …)).toEqual([])`. Leaves those groups at Read. */

export interface ContractCall {
  /** Sandbox code that makes the call and returns its result, e.g. `return await acme.call('x');`. */
  code: string;
  /** The catalog key the call resolves to. */
  key: string;
}

export interface PluginContractOptions {
  /** A read, run with its group at Read. */
  read: ContractCall;
  /** A write, refused while its group is at Read. */
  write: ContractCall;
  /** A locked operation; approved by typing `confirm`, after checking a wrong literal is refused. */
  locked?: ContractCall & { confirm: string };
  /** A read whose upstream response holds these secret values; none may reach the sandbox. */
  secrets?: { code: string; values: string[] };
}

const groupOf = (h: PluginHarness, key: string) => h.operation(key).pluginGroup;

export async function checkPluginContract(h: PluginHarness, opts: PluginContractOptions): Promise<string[]> {
  const issues: string[] = [];
  const setLevel = (key: string, level: AccessLevel) => h.setGroupLevel(groupOf(h, key), level);

  if (h.instance()?.lastSyncStatus !== 'ok') issues.push(`sync: status is ${h.instance()?.lastSyncStatus}`);
  if (h.operations().length === 0) issues.push('sync: the catalog is empty');

  for (const [name, call] of Object.entries({ read: opts.read, write: opts.write, locked: opts.locked })) {
    if (!call) continue;
    try {
      const op = h.operation(call.key);
      if (name === 'read' && op.classification !== 'read') issues.push(`${call.key}: expected a read`);
      if (name !== 'read' && op.classification !== 'write') issues.push(`${call.key}: expected a write`);
      if (name === 'locked' && !op.locked) issues.push(`${call.key}: expected locked`);
    } catch (err) {
      issues.push(`${name}: ${(err as Error).message}`);
      return issues;
    }
  }

  setLevel(opts.read.key, 'read');
  const read = await h.execute(opts.read.code);
  if (!read.ok) issues.push(`read ${opts.read.key}: failed at Read (${JSON.stringify(read.error)})`);

  setLevel(opts.write.key, 'read');
  const write = await h.execute(opts.write.code);
  if (write.ok || write.error?.code !== 'OPERATION_DISABLED')
    issues.push(
      `write ${opts.write.key}: expected OPERATION_DISABLED at Read, got ${JSON.stringify(write.ok ? 'ok' : write.error)}`,
    );

  if (opts.locked) {
    const locked = opts.locked;
    // A locked operation is off until enabled on its own; Ask is the level that allows it with a human.
    h.setOperationLevel(locked.key, 'ask');
    const without = await h.execute(locked.code);
    if (without.ok) issues.push(`locked ${locked.key}: ran without an approval`);
    const before = h.approvalErrors.length;
    let wrongRefused = false;
    let literal: string | null = null;
    const approved = await h.execute(locked.code, {
      onApproval: (a) => {
        literal = a.pending.confirmLiteral;
        try {
          a.approve(`${locked.confirm} (wrong)`);
        } catch {
          wrongRefused = true;
          a.approve(locked.confirm);
        }
      },
    });
    if (!wrongRefused) issues.push(`locked ${locked.key}: a wrong confirmation literal was accepted`);
    if (literal !== locked.confirm)
      issues.push(
        `locked ${locked.key}: confirmation literal is ${JSON.stringify(literal)}, expected ${JSON.stringify(locked.confirm)}`,
      );
    if (!approved.ok) issues.push(`locked ${locked.key}: failed after approval (${JSON.stringify(approved.error)})`);
    if (h.approvalErrors.length > before)
      issues.push(`locked ${locked.key}: approval errors ${h.approvalErrors.slice(before).map(String).join('; ')}`);
    h.setOperationLevel(locked.key, null);
  }

  if (opts.secrets) {
    const result = await h.execute(opts.secrets.code);
    const text = JSON.stringify(result);
    if (!result.ok) issues.push(`secrets: the call failed (${JSON.stringify(result.error)})`);
    for (const value of opts.secrets.values)
      if (text.includes(value)) issues.push(`secrets: ${JSON.stringify(value.slice(0, 4))}… reached the sandbox`);
  }

  for (const call of [opts.read, opts.write, opts.locked]) {
    if (call && h.audit({ operationKey: call.key }).length === 0) issues.push(`audit: no entry for ${call.key}`);
  }
  return issues;
}
