import { z } from 'zod';
import { cleanStored, parseLeniently } from '../lenient.js';

/** Per-instance runtime settings (design §8.2 "Instance Settings"), stored as JSON on `plugin_instances.settings`. */
export const InstanceSettingsSchema = z
  .object({
    /** Unanswered approvals are auto-denied after this long. */
    approvalTimeoutMs: z
      .number()
      .int()
      .min(10_000)
      .max(24 * 60 * 60_000)
      .default(15 * 60_000),
    /** Let form-prompt-only clients approve plain writes. Off by default: any client could then approve its
     * own writes. URL prompts always work. */
    formElicitationApprovals: z.enum(['off', 'writes']).default('off'),
    /** Longest session grant an approver can give (design §5.8); 0 turns "Approve for this session" off. */
    sessionGrantMaxHours: z.number().int().min(0).max(24).default(8),
    /** `execute` and `search` runs per minute, per principal (design §5.2). */
    executePerMinute: z.number().int().min(1).max(10_000).default(30),
    writesPerMinute: z.number().int().min(1).max(10_000).default(10),
    sandbox: z
      .object({
        timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
        memoryMb: z.number().int().min(8).max(1024).default(64),
        maxResultBytes: z
          .number()
          .int()
          .min(1024)
          .max(4 * 1024 * 1024)
          .default(64 * 1024),
      })
      .prefault({}),
    extraRedactKeys: z.array(z.string().min(1)).default([]),
    /** Re-sync the catalog on session start when the last sync is older than this (design §10). */
    syncMaxAgeMs: z
      .number()
      .int()
      .min(60_000)
      .max(7 * 24 * 60 * 60_000)
      .default(60 * 60_000),
    /** Plugin child heap limit (design §4.4). */
    memoryMb: z.number().int().min(64).max(4096).default(256),
  })
  .prefault({});

export type InstanceSettings = z.infer<typeof InstanceSettingsSchema>;

export function parseInstanceSettings(raw: unknown): InstanceSettings {
  return InstanceSettingsSchema.parse(raw ?? {});
}

/** Stored instance settings, read leniently (a field a newer schema rejects falls back to its default). */
export function readInstanceSettings(raw: unknown, label = 'instance settings'): InstanceSettings {
  return parseLeniently(InstanceSettingsSchema, raw, label);
}

/** For the startup normalization: the stored settings with just the rejected fields removed. */
export function cleanInstanceSettings(raw: unknown, label: string) {
  return cleanStored(InstanceSettingsSchema, raw, label);
}
