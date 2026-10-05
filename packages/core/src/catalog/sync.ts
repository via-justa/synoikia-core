import { randomUUID } from 'node:crypto';
import type { Manifest } from '@synoikia/plugin-sdk';
import { SyncCatalogResultSchema } from '@synoikia/plugin-sdk';
import { and, eq, inArray } from 'drizzle-orm';
import { writeAudit } from '../audit.js';
import type { Db } from '../db/index.js';
import { operationGroupAliases, operationGroups, operations, pluginInstances, preApprovalRules } from '../db/schema.js';
import { ValidationError } from '../errors.js';
import { levelInForce, normalizeLevel } from '../gate/access.js';
import type { AccessLevel } from '../gate/access.js';
import { MatchSchema } from '../gate/match.js';
import { matchMisfit } from './rules.js';

type OperationRow = typeof operations.$inferSelect;

export interface SyncSummary {
  added: number;
  updated: number;
  staled: number;
  restored: number;
  newGroups: string[];
  /** Writes (new, reclassified read → write, changed, or back from stale) now waiting for acknowledgement. */
  pendingReview: string[];
  /** Operations that became locked in this sync; their pre-approval rules were disabled. */
  newlyLocked: string[];
  /** Rules disabled because their operation became locked or their match no longer fits it. */
  rulesDisabled: number;
}

/** What an acknowledgement covers: a change to any of these makes the write ask again. */
const fingerprint = (op: Pick<OperationRow, 'kind' | 'paramsSchema' | 'matchProfile' | 'locked'>) =>
  JSON.stringify([op.kind, op.paramsSchema ?? null, op.matchProfile ?? null, op.locked]);

const isEffectiveWrite = (op: Pick<OperationRow, 'classification' | 'locked'>) =>
  op.locked || op.classification === 'write';

/**
 * Applies a plugin's `syncCatalog` result to an instance (design §5.2.1, §10). Plugin output is
 * untrusted and re-validated here. Runs in one transaction: either the whole catalog lands or none.
 *
 * - Operations missing from the result are marked `stale`, never deleted (history is kept).
 * - Read or write always comes from the plugin (the upstream API decides); `locked` follows its seed.
 * - New writes, and reads reclassified to writes, arrive unacknowledged (quarantined). So does an
 *   acknowledged write whose parameters, kind, match profile or lock changed, or that returns from
 *   stale: the admin acknowledged what it was, not what it became.
 * - Enabled pre-approval rules are re-checked against the new catalog (and the plugin's match
 *   profiles, when given); rules that no longer fit are disabled and audited.
 * - Plugin groups are mapped through admin aliases; missing groups are created at `ask`.
 * - An operation that appears in a group that already existed gets its own level, so a group an admin
 *   already opened never exposes it by itself: reads at Read, writes at None. In a group at None it
 *   just follows the group. Operations in a brand-new group follow it.
 * - An operation's own level that no longer fits its kind (it became a write, or locked) is narrowed.
 */
export function applyCatalogSync(
  db: Db,
  instanceId: string,
  rawResult: unknown,
  now = new Date(),
  manifest?: Pick<Manifest, 'matchProfiles' | 'targets'>,
): SyncSummary {
  const result = SyncCatalogResultSchema.parse(rawResult);
  const seen = new Set<string>();
  for (const d of result.operations) {
    if (seen.has(d.key)) throw new ValidationError('duplicate_operation', `Duplicate operation key: ${d.key}`);
    seen.add(d.key);
  }

  return db.transaction((tx) => {
    const aliases = new Map(
      tx
        .select()
        .from(operationGroupAliases)
        .where(eq(operationGroupAliases.instanceId, instanceId))
        .all()
        .map((a) => [a.pluginGroup, a.groupKey]),
    );
    const groups = new Map(
      tx
        .select()
        .from(operationGroups)
        .where(eq(operationGroups.instanceId, instanceId))
        .all()
        .map((g) => [g.key, g]),
    );
    const existing = new Map(
      tx
        .select()
        .from(operations)
        .where(eq(operations.instanceId, instanceId))
        .all()
        .map((o) => [o.key, o]),
    );

    // Groups as they were before this sync: only operations new to one of these become exceptions.
    const groupsBefore = new Map([...groups.values()].map((g) => [g.id, g]));

    const summary: SyncSummary = {
      added: 0,
      updated: 0,
      staled: 0,
      restored: 0,
      newGroups: [],
      pendingReview: [],
      newlyLocked: [],
      rulesDisabled: 0,
    };

    const groupIdFor = (pluginGroup: string, label: string | undefined): string => {
      const key = aliases.get(pluginGroup) ?? pluginGroup;
      const found = groups.get(key);
      if (found) return found.id;
      const row = { id: randomUUID(), instanceId, key, label: label ?? key, level: 'ask' as const, firstSeenAt: now };
      tx.insert(operationGroups).values(row).run();
      groups.set(key, { ...row, levelChangedAt: null, levelChangedBy: null, stale: false });
      summary.newGroups.push(key);
      return row.id;
    };

    for (const d of result.operations) {
      const prev = existing.get(d.key);
      const locked = d.locked;
      const classification = locked ? 'write' : d.classification;
      const classificationSource = locked ? 'locked' : 'inferred';
      const fields = {
        displayName: d.displayName ?? null,
        kind: d.kind,
        pluginGroup: d.group,
        groupId: groupIdFor(d.group, d.groupLabel),
        tag: d.tag ?? null,
        classification,
        classificationSource,
        inferredClassification: d.classification,
        inferredReason: d.classificationReason,
        locked,
        // A locked operation always needs the typed confirmation, whatever the plugin says.
        typedConfirmation: locked || (d.typedConfirmation ?? false),
        needsReview: d.needsReview,
        matchProfile: d.matchProfile ?? null,
        paramsSchema: d.paramsSchema ?? null,
        sensitiveParams: d.sensitiveParams ?? null,
        sensitiveResult: d.sensitiveResult ?? null,
        docs: d.docs ?? null,
        lastSeenAt: now,
        stale: false,
      } as const;
      const nowWrite = isEffectiveWrite({ classification, locked });

      if (!prev) {
        const group = groupsBefore.get(fields.groupId);
        const ownLevel =
          group && group.level !== 'none' && !locked ? (nowWrite ? ('none' as const) : ('read' as const)) : null;
        tx.insert(operations)
          .values({
            id: randomUUID(),
            instanceId,
            key: d.key,
            ...fields,
            levelOverride: ownLevel,
            attestationRequired: d.attestationRequired,
            firstSeenAt: now,
          })
          .run();
        summary.added++;
        if (nowWrite) summary.pendingReview.push(d.key);
        continue;
      }

      const becameLocked = locked && !prev.locked;
      const changed = fingerprint(prev) !== fingerprint(fields) || prev.stale;
      const becameWrite = nowWrite && (!isEffectiveWrite(prev) || (prev.writeAcknowledged && changed));
      // Its own level, made to fit what it is now. A newly locked op starts closed again (it needs its
      // own `ask`). One the plugin moved to another group keeps the access it had there, so a regroup
      // never opens it wider (a new group starts at `ask`; an existing one may be at `write`).
      let levelOverride: AccessLevel | null = prev.levelOverride;
      if (becameLocked) levelOverride = null;
      else if (prev.levelOverride !== null)
        levelOverride = normalizeLevel({ classification, locked }, prev.levelOverride);
      else if (prev.groupId !== fields.groupId && !locked) {
        const had = levelInForce(
          { classification: prev.classification, locked: prev.locked, levelOverride: null, writeAcknowledged: false },
          groupsBefore.get(prev.groupId),
        );
        const newGroup = [...groups.values()].find((g) => g.id === fields.groupId);
        const kind = { classification, locked, levelOverride: null, writeAcknowledged: false };
        // Only an exception when following the new group would give it different access.
        if (levelInForce(kind, newGroup) !== normalizeLevel(kind, had)) levelOverride = normalizeLevel(kind, had);
      }
      tx.update(operations)
        .set({
          ...fields,
          // The plugin can add the attestation requirement; only an admin can remove it (and then it stays off).
          attestationRequired: prev.attestationRequired || (d.attestationRequired && !prev.attestationWaived),
          ...(becameWrite ? { writeAcknowledged: false, acknowledgedAt: null, acknowledgedBy: null } : {}),
          ...(levelOverride !== prev.levelOverride ? { levelOverride } : {}),
        })
        .where(eq(operations.id, prev.id))
        .run();
      summary.updated++;
      if (prev.stale) summary.restored++;
      if (becameWrite) summary.pendingReview.push(d.key);
      if (becameLocked) summary.newlyLocked.push(prev.id);
    }

    const missing = [...existing.values()].filter((o) => !seen.has(o.key) && !o.stale).map((o) => o.id);
    if (missing.length > 0) {
      tx.update(operations).set({ stale: true }).where(inArray(operations.id, missing)).run();
      summary.staled = missing.length;
    }

    if (summary.newlyLocked.length > 0) {
      summary.rulesDisabled = tx
        .update(preApprovalRules)
        .set({ enabled: false, updatedAt: now })
        .where(and(inArray(preApprovalRules.operationId, summary.newlyLocked), eq(preApprovalRules.enabled, true)))
        .run().changes;
    }

    // Rules name fields of the operation's match profile; a plugin update can remove or retype them.
    const misfits: { ruleId: string; operationKey: string; reason: string }[] = [];
    if (manifest) {
      const enabled = tx
        .select({ rule: preApprovalRules, op: operations })
        .from(preApprovalRules)
        .innerJoin(operations, eq(preApprovalRules.operationId, operations.id))
        .where(and(eq(preApprovalRules.instanceId, instanceId), eq(preApprovalRules.enabled, true)))
        .all();
      for (const { rule, op } of enabled) {
        const match = MatchSchema.safeParse(rule.match);
        const misfit = match.success ? matchMisfit(manifest, op, match.data) : match.error;
        if (!misfit) continue;
        tx.update(preApprovalRules)
          .set({ enabled: false, updatedAt: now })
          .where(eq(preApprovalRules.id, rule.id))
          .run();
        misfits.push({ ruleId: rule.id, operationKey: op.key, reason: misfit.message });
      }
      summary.rulesDisabled += misfits.length;
    }

    // A group is stale when none of its operations are live; its level is kept in case they return.
    const liveGroupIds = new Set(
      tx
        .select({ groupId: operations.groupId })
        .from(operations)
        .where(and(eq(operations.instanceId, instanceId), eq(operations.stale, false)))
        .all()
        .map((r) => r.groupId),
    );
    for (const g of groups.values()) {
      const stale = !liveGroupIds.has(g.id);
      if (stale !== g.stale) tx.update(operationGroups).set({ stale }).where(eq(operationGroups.id, g.id)).run();
    }

    tx.update(pluginInstances)
      .set({
        upstreamVersion: result.upstreamVersion,
        sourceRef: result.sourceRef ?? null,
        lastSyncedAt: now,
        lastSyncStatus: 'ok',
      })
      .where(eq(pluginInstances.id, instanceId))
      .run();

    const newlyLockedKeys = [...existing.values()].filter((o) => summary.newlyLocked.includes(o.id)).map((o) => o.key);
    writeAudit(
      tx,
      {
        kind: 'plugin',
        instanceId,
        decision: 'catalog_synced',
        actorKind: 'system',
        detail: { ...summary, newlyLocked: newlyLockedKeys, upstreamVersion: result.upstreamVersion },
      },
      now,
    );
    if (misfits.length > 0) {
      writeAudit(
        tx,
        {
          kind: 'config',
          instanceId,
          decision: 'rules_disabled_operation_changed',
          actorKind: 'system',
          detail: { rules: misfits },
        },
        now,
      );
    }
    if (summary.newlyLocked.length > 0 && summary.rulesDisabled > misfits.length) {
      writeAudit(
        tx,
        {
          kind: 'config',
          instanceId,
          decision: 'rules_disabled_operation_locked',
          actorKind: 'system',
          detail: { operations: newlyLockedKeys, rulesDisabled: summary.rulesDisabled - misfits.length },
        },
        now,
      );
    }
    return { ...summary, newlyLocked: newlyLockedKeys };
  });
}
