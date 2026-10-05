import { createHmac, randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { aad } from '../crypto/index.js';
import type { SecretBox } from '../crypto/index.js';
import type { Db } from '../db/index.js';
import { notifierChannels } from '../db/schema.js';
import { NotFoundError, ValidationError } from '../errors.js';
import type { CoreEventMap, CoreEventName, CoreEvents } from '../events.js';

/** Notification channels (design §9): ntfy and signed webhooks, informational only; payloads carry
 * summaries, never raw params or secrets. */

const NOTIFY_EVENTS = [
  'instance.error',
  'instance.recovered',
  'plugin.crashed',
  'sync.failed',
  'sync.pending_review',
  'auth.lockout',
] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

/** Channels saved before approval notifications were removed may still list those events. */
const knownEvents = (events: string[]) =>
  events.filter((e): e is NotifyEvent => NOTIFY_EVENTS.includes(e as NotifyEvent));

const NtfyConfig = z.object({
  server: z.url().default('https://ntfy.sh'),
  topic: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'letters, digits, - and _'),
});
const WebhookConfig = z.object({ url: z.url() });

const ChannelInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ntfy'),
    name: z.string().trim().min(1).max(100),
    config: NtfyConfig,
    secrets: z.object({ token: z.string().nullable().optional() }).default({}),
    events: z.array(z.enum(NOTIFY_EVENTS)).min(1),
    instanceFilter: z.array(z.string()).nullable().default(null),
    enabled: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal('webhook'),
    name: z.string().trim().min(1).max(100),
    config: WebhookConfig,
    secrets: z
      .object({
        hmacSecret: z.string().nullable().optional(),
        headers: z.record(z.string(), z.string()).nullable().optional(),
      })
      .default({}),
    events: z.array(z.enum(NOTIFY_EVENTS)).min(1),
    instanceFilter: z.array(z.string()).nullable().default(null),
    enabled: z.boolean().default(true),
  }),
]);

type ChannelRow = typeof notifierChannels.$inferSelect;
type Secrets = { token?: string; hmacSecret?: string; headers?: Record<string, string> };

export interface Notification {
  event: NotifyEvent;
  instance?: { id: string; slug: string };
  title: string;
  message: string;
  data: Record<string, unknown>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

export class NotifierService {
  private readonly lastStatus = new Map<string, string>();

  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
    private readonly opts: {
      fetch?: FetchLike;
      retryDelaysMs?: number[];
      now?: () => Date;
    } = {},
  ) {}

  private secretsOf(row: ChannelRow): Secrets {
    return row.secretsEnc
      ? this.box.decryptJson<Secrets>(row.secretsEnc, aad('notifier_channels', 'secrets_enc', row.id))
      : {};
  }

  private publicRow(row: ChannelRow) {
    const s = this.secretsOf(row);
    return {
      ...row,
      events: knownEvents(row.events),
      secretsEnc: undefined,
      secrets: {
        ...(row.kind === 'ntfy' ? { token: { set: !!s.token } } : {}),
        ...(row.kind === 'webhook'
          ? { hmacSecret: { set: !!s.hmacSecret }, headers: { set: !!s.headers && Object.keys(s.headers).length > 0 } }
          : {}),
      },
    };
  }

  list() {
    return this.db
      .select()
      .from(notifierChannels)
      .orderBy(asc(notifierChannels.name))
      .all()
      .map((r) => this.publicRow(r));
  }

  private mergeSecrets(current: Secrets, patch: Record<string, unknown>): Secrets {
    const next: Secrets = { ...current };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (v === null || v === '') delete next[k as keyof Secrets];
      else (next as Record<string, unknown>)[k] = v;
    }
    return next;
  }

  save(raw: unknown, opts: { id?: string; actor?: { userId?: string } } = {}) {
    const existing = opts.id
      ? this.db.select().from(notifierChannels).where(eq(notifierChannels.id, opts.id)).get()
      : undefined;
    if (opts.id && !existing) throw new NotFoundError('channel_not_found', 'No such channel');
    const merged = existing
      ? {
          kind: existing.kind,
          name: existing.name,
          config: existing.config,
          events: knownEvents(existing.events),
          instanceFilter: existing.instanceFilter,
          enabled: existing.enabled,
          ...(raw as object),
        }
      : raw;
    const parsed = ChannelInputSchema.safeParse(merged);
    if (!parsed.success)
      throw new ValidationError(
        'invalid_channel',
        'Invalid channel',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      );
    const input = parsed.data;
    if (existing && existing.kind !== input.kind)
      throw new ValidationError('kind_immutable', 'A channel’s kind cannot change');
    const id = existing?.id ?? randomUUID();
    const secrets = this.mergeSecrets(
      existing ? this.secretsOf(existing) : {},
      input.secrets as Record<string, unknown>,
    );
    const values = {
      id,
      kind: input.kind,
      name: input.name,
      config: input.config,
      secretsEnc: Object.keys(secrets).length
        ? this.box.encryptJson(secrets, aad('notifier_channels', 'secrets_enc', id))
        : null,
      events: input.events,
      instanceFilter: input.instanceFilter,
      enabled: input.enabled,
    };
    this.db.transaction((tx) => {
      if (existing) tx.update(notifierChannels).set(values).where(eq(notifierChannels.id, id)).run();
      else tx.insert(notifierChannels).values(values).run();
      writeAudit(tx, {
        kind: 'config',
        decision: existing ? 'notifier_updated' : 'notifier_created',
        actorKind: 'user',
        actorId: opts.actor?.userId,
        detail: {
          id,
          kind: input.kind,
          name: input.name,
          config: input.config,
          events: input.events,
          secretsChanged: Object.keys(input.secrets),
        },
      });
    });
    return this.publicRow(this.db.select().from(notifierChannels).where(eq(notifierChannels.id, id)).get()!);
  }

  remove(id: string, actor: { userId?: string } = {}) {
    const row = this.db.select().from(notifierChannels).where(eq(notifierChannels.id, id)).get();
    if (!row) throw new NotFoundError('channel_not_found', 'No such channel');
    this.db.transaction((tx) => {
      tx.delete(notifierChannels).where(eq(notifierChannels.id, id)).run();
      writeAudit(tx, {
        kind: 'config',
        decision: 'notifier_deleted',
        actorKind: 'user',
        actorId: actor.userId,
        detail: { id, name: row.name },
      });
    });
  }

  /** Sends a test message to one channel, bypassing its event filter. */
  async test(id: string) {
    const row = this.db.select().from(notifierChannels).where(eq(notifierChannels.id, id)).get();
    if (!row) throw new NotFoundError('channel_not_found', 'No such channel');
    return this.deliver(row, {
      event: 'sync.failed',
      title: 'Test notification',
      message: 'Notifications from Synoikia are working.',
      data: { test: true },
    });
  }

  /** Wires channels to the event bus. Returns an unsubscribe function. */
  subscribe(events: CoreEvents): () => void {
    const offs: (() => void)[] = [];
    const on = <K extends CoreEventName>(name: K, h: (...args: CoreEventMap[K]) => void) => {
      const listener = h as never;
      events.on(name, listener);
      offs.push(() => events.off(name, listener));
    };
    on('instance.status', (s) => {
      const prev = this.lastStatus.get(s.instanceId);
      this.lastStatus.set(s.instanceId, s.status);
      if (s.status === 'error' && prev !== 'error') {
        void this.dispatch({
          event: 'instance.error',
          instance: { id: s.instanceId, slug: s.slug },
          title: `/${s.slug} is down`,
          message: s.error ?? 'Plugin error',
          data: { error: s.error ?? null },
        });
      } else if (s.status === 'ready' && prev === 'error') {
        void this.dispatch({
          event: 'instance.recovered',
          instance: { id: s.instanceId, slug: s.slug },
          title: `/${s.slug} recovered`,
          message: 'The plugin is running again.',
          data: {},
        });
      }
    });
    on(
      'plugin.crashed',
      (p) =>
        void this.dispatch({
          event: 'plugin.crashed',
          instance: { id: p.instanceId, slug: p.slug },
          title: `Plugin for /${p.slug} crashed`,
          message: p.error,
          data: { error: p.error },
        }),
    );
    on(
      'sync.failed',
      (p) =>
        void this.dispatch({
          event: 'sync.failed',
          instance: { id: p.instanceId, slug: p.slug },
          title: `Catalog sync failed for /${p.slug}`,
          message: p.error,
          data: { error: p.error },
        }),
    );
    on('sync.completed', (p) => {
      const rulesDisabled = p.rulesDisabled ?? 0;
      if (p.pendingReview.length === 0 && rulesDisabled === 0) return;
      const lines = [];
      if (p.pendingReview.length > 0)
        lines.push(
          `New or changed writes ask for approval where their level is Write, until acknowledged: ${p.pendingReview.slice(0, 10).join(', ')}${p.pendingReview.length > 10 ? ', …' : ''}`,
        );
      if (rulesDisabled > 0)
        lines.push(`${rulesDisabled} pre-approval rule(s) no longer fit their operation and were disabled.`);
      void this.dispatch({
        event: 'sync.pending_review',
        instance: { id: p.instanceId, slug: p.slug },
        title:
          p.pendingReview.length > 0
            ? `${p.pendingReview.length} write operation(s) to review on /${p.slug}`
            : `Pre-approval rules disabled on /${p.slug}`,
        message: lines.join('\n'),
        data: { operations: p.pendingReview, rulesDisabled },
      });
    });
    on(
      'auth.lockout',
      (p) =>
        void this.dispatch({
          event: 'auth.lockout',
          title: 'Sign-in locked',
          message: `Too many failed sign-ins for "${p.username}" on the ${p.surface === 'mcp' ? 'MCP (internet-facing)' : 'admin'} sign-in page${p.ip ? ` from ${p.ip}` : ''}.`,
          data: { username: p.username, ip: p.ip ?? null, surface: p.surface ?? 'admin' },
        }),
    );
    return () => {
      for (const off of offs) off();
    };
  }

  /** Fans a notification out to every enabled channel subscribed to its event (and instance). */
  async dispatch(n: Notification) {
    const channels = this.db
      .select()
      .from(notifierChannels)
      .all()
      .filter(
        (ch) =>
          ch.enabled &&
          ch.events.includes(n.event) &&
          (!ch.instanceFilter?.length || (n.instance && ch.instanceFilter.includes(n.instance.id))),
      );
    await Promise.all(channels.map((ch) => this.deliver(ch, n)));
  }

  private async deliver(row: ChannelRow, n: Notification): Promise<{ ok: boolean; error?: string }> {
    const secrets = this.secretsOf(row);
    let request: { url: string; headers: Record<string, string>; body: string };
    if (row.kind === 'ntfy') {
      const cfg = NtfyConfig.parse(row.config);
      request = {
        url: cfg.server.replace(/\/+$/, ''),
        headers: {
          'content-type': 'application/json',
          ...(secrets.token ? { authorization: `Bearer ${secrets.token}` } : {}),
        },
        // JSON publishing: UTF-8 safe, unlike header-based publishing.
        body: JSON.stringify({
          topic: cfg.topic,
          title: n.title,
          message: n.message,
          priority: n.event.startsWith('instance') || n.event === 'plugin.crashed' ? 4 : 3,
          tags: [n.event.replace('.', '-')],
        }),
      };
    } else {
      const cfg = WebhookConfig.parse(row.config);
      const timestamp = Math.floor((this.opts.now?.() ?? new Date()).getTime() / 1000).toString();
      const body = JSON.stringify({
        event: n.event,
        at: new Date(Number(timestamp) * 1000).toISOString(),
        instance: n.instance ?? null,
        title: n.title,
        message: n.message,
        data: n.data,
      });
      request = {
        url: cfg.url,
        headers: {
          ...(secrets.headers ?? {}),
          'content-type': 'application/json',
          'x-synoikia-event': n.event,
          'x-synoikia-timestamp': timestamp,
          ...(secrets.hmacSecret
            ? {
                'x-synoikia-signature': `sha256=${createHmac('sha256', secrets.hmacSecret).update(`${timestamp}.${body}`).digest('hex')}`,
              }
            : {}),
        },
        body,
      };
    }

    const doFetch: FetchLike = this.opts.fetch ?? ((url, init) => fetch(url, init));
    const delays = this.opts.retryDelaysMs ?? [1000, 4000];
    let lastError = '';
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, delays[attempt - 1]));
      try {
        const res = await doFetch(request.url, {
          method: 'POST',
          headers: request.headers,
          body: request.body,
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          this.db
            .update(notifierChannels)
            .set({ lastSentAt: this.opts.now?.() ?? new Date(), lastError: null })
            .where(eq(notifierChannels.id, row.id))
            .run();
          return { ok: true };
        }
        lastError = `HTTP ${res.status}`;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break; // won't succeed on retry
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    this.db
      .update(notifierChannels)
      .set({ lastError: lastError.slice(0, 300) })
      .where(eq(notifierChannels.id, row.id))
      .run();
    return { ok: false, error: lastError };
  }
}
