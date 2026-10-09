import path from 'node:path';
import { SessionGrantService } from './approvals/grants.js';
import { ApprovalLinkService } from './approvals/links.js';
import { ApprovalService } from './approvals/service.js';
import { McpTokenService } from './auth/mcp-tokens.js';
import { OAuthService } from './auth/oauth.js';
import { OidcService } from './auth/oidc.js';
import { SessionService } from './auth/sessions.js';
import { LoginThrottle } from './auth/throttle.js';
import { RoleService } from './auth/roles.js';
import { UserService } from './auth/users.js';
import type { Config } from './config/env.js';
import { loadMasterKey, SecretBox } from './crypto/index.js';
import { openDatabase } from './db/index.js';
import type { Db } from './db/index.js';
import { CoreEvents } from './events.js';
import { SlidingWindowLimiter } from './gate/rate-limit.js';
import type { GateDeps } from './gate/pipeline.js';
import { InstanceManager } from './instances/manager.js';
import { createLogger } from './log.js';
import type { Logger } from './log.js';
import { runHousekeeping } from './maintenance.js';
import type { ManagerOptions } from './instances/manager.js';
import { NotifierService } from './notify/service.js';
import type { FetchLike } from './notify/service.js';
import { discoverPlugins, syncPluginRegistry } from './plugins/discovery.js';
import { PluginRepoService } from './plugins/repos.js';
import type { FetchBytes } from './plugins/repos.js';
import { ExecutionRegistry } from './runtime/executions.js';
import { sandboxesRunning } from './runtime/index.js';
import { normalizeStoredSettings } from './settings.js';

/** Wires every core service once (design §2): one database, approval service and event bus for
 * both listeners, the scheduler and tests. */

export interface AppContext {
  config: Config;
  /** Server log, filtered by LOG_LEVEL. */
  log: Logger;
  db: Db;
  secrets: SecretBox;
  events: CoreEvents;
  users: UserService;
  roles: RoleService;
  sessions: SessionService;
  throttle: LoginThrottle;
  oidc: OidcService;
  tokens: McpTokenService;
  oauth: OAuthService;
  instances: InstanceManager;
  approvals: ApprovalService;
  /** Session grants (design §5.8). */
  grants: SessionGrantService;
  /** Parked executions (design §5.6). */
  executions: ExecutionRegistry;
  limiter: SlidingWindowLimiter;
  links: ApprovalLinkService;
  notifier: NotifierService;
  repos: PluginRepoService;
  keys: { attestation: Buffer; state: Buffer };
  warnings: string[];
  now: () => Date;
  gateDeps(): GateDeps;
  /** Re-scan plugin directories and update the registry (startup, after installs). */
  discoverPlugins(): ReturnType<typeof syncPluginRegistry>;
  start(): Promise<void>;
  /** Registers cleanup to run when draining (e.g. closing open MCP sessions). */
  onStop(fn: () => unknown): void;
  /** Aborted when shutdown begins; long-lived responses (SSE) end on it. */
  shutdownSignal: AbortSignal;
  /** First shutdown step, while listeners still run: stop timers, cancel approvals, run stop hooks and
   * end long-lived streams. */
  drain(): Promise<void>;
  /** Drains (if not yet), stops plugin children and closes the database. */
  stop(): Promise<void>;
}

export interface AppOptions {
  now?: () => Date;
  supervisor?: ManagerOptions['supervisor'];
  /** Allow http:// OIDC issuers (tests, lab IdPs). */
  oidcAllowInsecure?: boolean;
  /** Use an in-memory database (tests). */
  memoryDb?: boolean;
  /** Outbound HTTP for notifications (tests). */
  notifyFetch?: FetchLike;
  notifyRetryDelaysMs?: number[];
  /** Outbound HTTP for plugin repositories (tests). */
  repoFetch?: FetchBytes;
  repoAllowHttp?: boolean;
  /** Replaces the LOG_LEVEL logger (tests). */
  log?: Logger;
}

export async function createAppContext(config: Config, opts: AppOptions = {}): Promise<AppContext> {
  const now = opts.now ?? (() => new Date());
  const warnings: string[] = [];
  const master = loadMasterKey({ envKey: config.MASTER_KEY, dataDir: config.DATA_DIR });
  if (master.warning) warnings.push(master.warning);
  const secrets = SecretBox.fromKey(master.key);

  const db = opts.memoryDb ? openDatabase(':memory:') : openDatabase({ dataDir: config.DATA_DIR });
  const orphans = ApprovalService.denyOrphans(db);
  if (orphans > 0) warnings.push(`Denied ${orphans} approval(s) left pending by the previous run`);

  const events = new CoreEvents();
  const users = new UserService(db, secrets);
  const boot = await users.bootstrap(config.ADMIN_BOOTSTRAP_USERNAME, config.ADMIN_BOOTSTRAP_PASSWORD);
  if (boot === 'created')
    warnings.push(`Created admin user "${config.ADMIN_BOOTSTRAP_USERNAME}" from ADMIN_BOOTSTRAP_*`);
  if (boot === 'ignored') warnings.push('ADMIN_BOOTSTRAP_* is set but users already exist; it is ignored — remove it');

  const instances = new InstanceManager({ db, secrets, events, now, supervisor: opts.supervisor });
  // Stored JSON from an earlier release is brought to the current schemas once, before anything reads it.
  normalizeStoredSettings(db);
  instances.normalizeStoredSettings();
  if (!config.PUBLIC_MCP_URL)
    warnings.push(
      'PUBLIC_MCP_URL is not set: OAuth is off (bearer tokens still work). Set it to the public address of the MCP port.',
    );
  const links = new ApprovalLinkService(db, now);
  const approvals = new ApprovalService(db, links, now);
  const grants = new SessionGrantService(db, now);
  const executions = new ExecutionRegistry(() => now().getTime());
  // An approval, a parked run or a grant must not outlive the plugin process and configuration it was given for.
  events.on('instance.status', ({ instanceId, status }) => {
    if (status !== 'stopped') return;
    approvals.cancelForInstance(instanceId, 'endpoint_stopped');
    executions.abort(instanceId);
    grants.endForInstance(instanceId, 'endpoint_stopped');
  });

  const keys = {
    attestation: secrets.deriveKey('attestation'),
    state: secrets.deriveKey('signed-state'),
  };
  const limiter = new SlidingWindowLimiter();
  const notifier = new NotifierService(db, secrets, {
    fetch: opts.notifyFetch,
    retryDelaysMs: opts.notifyRetryDelaysMs,
    now,
  });
  const unsubscribeNotifier = notifier.subscribe(events);
  const discover = () => syncPluginRegistry(db, discoverPlugins(path.join(config.DATA_DIR, 'plugins')));
  const registered = discover();
  const repos = new PluginRepoService({
    db,
    dataDir: config.DATA_DIR,
    fetch: opts.repoFetch,
    allowHttp: opts.repoAllowHttp,
    now,
    discover,
    stopPlugin: (id) => instances.stopPlugin(id),
    startPlugin: (id) => instances.startPlugin(id),
  });
  for (const id of registered.rejected) warnings.push(`Plugin ${id} was ignored: its id is already taken`);

  const timers: NodeJS.Timeout[] = [];
  const stopHooks: (() => unknown)[] = [];
  const draining = new AbortController();
  const drain = async () => {
    if (draining.signal.aborted) return;
    draining.abort();
    for (const t of timers) clearInterval(t);
    // Cancelled approvals end their tool calls first, so closing sessions doesn't cut them off mid-reply.
    approvals.cancelAll('shutdown');
    executions.abort();
    // Give the scripts those calls belonged to a moment to return their result to the client.
    if (sandboxesRunning() > 0) {
      for (const until = Date.now() + 2000; sandboxesRunning() > 0 && Date.now() < until;)
        await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 50)); // the reply is written after the script returns
    }
    for (const fn of stopHooks.splice(0).reverse()) await fn();
  };
  const ctx: AppContext = {
    config,
    log: opts.log ?? createLogger(config.LOG_LEVEL),
    db,
    secrets,
    events,
    users,
    roles: new RoleService(db),
    sessions: new SessionService(db, secrets.deriveKey('session-pepper'), now),
    throttle: new LoginThrottle(),
    oidc: new OidcService(db, secrets, keys.state, opts.oidcAllowInsecure ?? false),
    tokens: new McpTokenService(db, now),
    oauth: new OAuthService(db, now),
    instances,
    approvals,
    grants,
    executions,
    limiter,
    links,
    notifier,
    repos,
    keys,
    warnings,
    now,
    gateDeps: () => ({ db, approvals, limiter, attestationKey: keys.attestation, now, grants, executions }),
    discoverPlugins: discover,
    async start() {
      await instances.startAll();
      // Hourly: daily backstop sync per instance and per plugin repo (design §10), staggered by their
      // own last-run times, plus housekeeping.
      const hourly = () => {
        void instances.syncStale();
        void repos.refreshStale();
        try {
          runHousekeeping(ctx);
        } catch (err) {
          console.error('housekeeping failed', err);
        }
      };
      hourly();
      timers.push(setInterval(hourly, 60 * 60_000).unref());
    },
    onStop(fn) {
      stopHooks.push(fn);
    },
    shutdownSignal: draining.signal,
    drain,
    async stop() {
      await drain();
      unsubscribeNotifier();
      await instances.stopAll();
      db.$client.close();
    },
  };
  // Grants from before instance binding (design §6.2) get the ids their slugs name today.
  ctx.oauth.backfillInstanceIds(instances.list());
  return ctx;
}
