import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { Manifest } from '@synoikia/plugin-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import type { Config } from '../../config/env.js';
import type { ClientPrompts } from '../../approvals/service.js';
import { authenticateMcp, effectiveAuthMode, publicMcpBase } from '../../auth/mcp-auth.js';
import { TOKEN_PREFIX } from '../../auth/mcp-tokens.js';
import { ACCESS_PREFIX } from '../../auth/oauth.js';
import type { McpIdentity } from '../../auth/mcp-auth.js';
import type { OAuthService } from '../../auth/oauth.js';
import type { CallerContext } from '../../gate/pipeline.js';
import { executeCode, resumeExecution, searchCode } from '../../runtime/index.js';
import type { ExecuteResult } from '../../runtime/executions.js';
import type { LogFields } from '../../log.js';
import { clientIp } from '../common.js';
import { APPROVAL_CARD_HTML, APPROVAL_CARD_URI, MCP_APP_MIME, MCP_APPS_EXTENSION } from './approval-card.js';

/** `/{slug}` Streamable HTTP endpoints (design §2.2): one McpServer per session, bound to its instance
 * and principal, exposing `search`, `execute` and `resume`, plus the approval card's app-only tools. */

const SESSION_IDLE_MS = 30 * 60_000;
/** Open MCP sessions per authenticated principal; a new one past the cap closes that principal's oldest. */
export const MAX_SESSIONS_PER_PRINCIPAL = 16;
const SERVER_VERSION = '0.1.0';

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  /** Aborted when the session closes: its executions end and their open approvals are cancelled. */
  closed: AbortController;
  instanceId: string;
  principal: string;
  lastSeen: number;
}

const jsonRpcError = (code: number, message: string) => ({
  jsonrpc: '2.0' as const,
  id: null,
  error: { code, message },
});

interface ToolExtras {
  /** Makes a parked approval's page path absolute. */
  publicBase: string;
  /** The caller's live session grant, shown on the approval card. */
  grant?: { id: string; expiresAt: Date };
}

function toolText(result: ExecuteResult, extras?: ToolExtras) {
  const sessionGrant = extras?.grant && { id: extras.grant.id, expiresAt: extras.grant.expiresAt.toISOString() };
  if (!result.ok && 'status' in result) {
    // Parked (design §5.6): not an error; the agent shows the link and calls resume.
    const body = {
      status: result.status,
      executionId: result.executionId,
      ...(result.approval
        ? {
            approval: {
              url: `${extras?.publicBase ?? ''}${result.approval.path}`,
              operationKey: result.approval.operationKey,
              summary: result.approval.summary,
              expiresAt: result.approval.expiresAt.toISOString(),
            },
          }
        : {}),
      next:
        result.status === 'awaiting_approval'
          ? 'Show approval.url to the user. After they approve or deny it, call resume with this executionId.'
          : 'Call resume with this executionId.',
      ...(sessionGrant ? { sessionGrant } : {}),
    };
    return { structuredContent: body, content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }] };
  }
  if (!result.ok) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              error: result.error.code,
              message: result.error.message,
              ...(result.logs.length ? { logs: result.logs } : {}),
            },
            null,
            2,
          ),
        },
      ],
    };
  }
  const body = {
    result: result.value,
    ...(result.truncated ? { truncated: true } : {}),
    ...(result.logs.length ? { logs: result.logs } : {}),
  };
  return {
    ...(sessionGrant ? { structuredContent: { sessionGrant } } : {}),
    content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }],
  };
}

function describeResume(manifest: Manifest): string {
  return [
    `Continue an execute call on ${manifest.name} that is waiting for approval, and get its result.`,
    'Pass the `executionId` from the `awaiting_approval` result. It waits up to 45 seconds; if the human has not decided yet, it returns `awaiting_approval` again with the same link. If the script reaches another approval, it returns the new link.',
  ].join('\n');
}

function describeSearch(manifest: Manifest): string {
  const ops = manifest.labels.operations.toLowerCase();
  const apis = [
    `catalog.find({ text?, group?, kind?, classification?: 'read'|'write'|'locked', includeDisabled?, limit? }) → ${ops} you can call (with includeDisabled, also the unavailable ones and why)`,
    'catalog.get(key) → one entry with its parameter schema and docs',
    'catalog.groups() → access groups with their level (none/read/ask/write) and counts',
  ];
  if (manifest.capabilities.registry)
    apis.push(
      'registry.find({ kind?, text?, parent?, scopes?, limit? }) → matching upstream objects, of the kinds this plugin mirrors',
    );
  if (manifest.capabilities.attestation) {
    apis.push(
      'guides.get(key) → best-practice guide; pass its best_practice_key in the params when calling that operation',
    );
  }
  return [
    `Search the ${manifest.name} ${ops} catalog. \`code\` is the body of an async JavaScript function; return a JSON-serializable value.`,
    'Available:',
    ...apis.map((a) => `- ${a}`),
    'Use this before execute to find operation keys and parameters. It never contacts the upstream.',
  ].join('\n');
}

function describeExecute(manifest: Manifest): string {
  const ns = manifest.binding.namespace;
  const fns = manifest.binding.functions.map((f) => `${ns}.${f}(…)`).join(', ');
  return [
    `Run code against ${manifest.name}. \`code\` is the body of an async JavaScript function; \`await\` ${fns} and return a JSON-serializable result.`,
    'Reads run immediately. Writes either run straight away or wait until a human approves them on an approval page (see `approval` in catalog entries); denials and other refusals throw an Error with `err.code` (e.g. OPERATION_DISABLED, PERMISSION_DENIED, UPSTREAM_ERROR) that your code can catch.',
    'If the result has `status: "awaiting_approval"`, the run is paused on the server: show `approval.url` to the user, and after they decide, call `resume` with its `executionId` (do not run the code again). Each write runs once.',
    'Calls run one at a time. There is no network, filesystem or timer access. Secrets in results are redacted.',
  ].join('\n');
}

/** DNS-rebinding defence: Host (and Origin, when sent) must be a configured name, localhost or an IP. */
export function hostAllowed(config: Config, hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  let host: string;
  try {
    host = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || isIP(host.replace(/^\[|\]$/g, ''))) return true;
  if (config.PUBLIC_MCP_URL && new URL(config.PUBLIC_MCP_URL).hostname.toLowerCase() === host) return true;
  return config.MCP_ALLOWED_HOSTS.includes(host);
}

function originAllowed(config: Config, origin: string | undefined): boolean {
  if (!origin) return true; // not a browser request
  try {
    return hostAllowed(config, new URL(origin).host);
  } catch {
    return false;
  }
}

/** A bearer token or Access assertion shaped like one this server could accept: a Synoikia token or a JWT. */
const TOKEN_SHAPE = new RegExp(`^(${TOKEN_PREFIX}|${ACCESS_PREFIX})\\S+$|^[\\w-]+\\.[\\w-]+\\.[\\w-]*$`);

function presentsCredential(c: Context): boolean {
  const bearer = c.req.header('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const assertion = c.req.header('cf-access-jwt-assertion');
  return (!!bearer && TOKEN_SHAPE.test(bearer)) || (!!assertion && TOKEN_SHAPE.test(assertion));
}

const THROTTLE_WINDOW_MS = 60_000;
const THROTTLE_MAX_KEYS = 1000;

/** At most one refusal log line per key per minute; the next one reports how many were dropped. */
export class LogThrottle {
  private readonly windows = new Map<string, { until: number; dropped: number }>();

  /** The number of lines dropped since the last one for this key, or null to drop this one too. */
  admit(key: string, now: number): number | null {
    const w = this.windows.get(key);
    if (w && now < w.until) {
      w.dropped++;
      return null;
    }
    if (!w && this.windows.size >= THROTTLE_MAX_KEYS) {
      for (const [k, v] of this.windows) if (v.until <= now) this.windows.delete(k);
      if (this.windows.size >= THROTTLE_MAX_KEYS) this.windows.clear();
    }
    this.windows.set(key, { until: now + THROTTLE_WINDOW_MS, dropped: 0 });
    return w?.dropped ?? 0;
  }
}

export class McpEndpoints {
  private readonly sessions = new Map<string, Session>();
  private readonly refusals = new LogThrottle();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly ctx: AppContext,
    private readonly oauth: OAuthService,
  ) {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  get sessionCount() {
    return this.sessions.size;
  }

  private sweep() {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, s] of this.sessions) if (s.lastSeen < cutoff) void this.closeSession(id);
  }

  private async closeSession(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    s.closed.abort();
    await s.transport.close().catch(() => undefined);
    await s.server.close().catch(() => undefined);
  }

  async closeAll() {
    clearInterval(this.sweeper);
    await Promise.all([...this.sessions.keys()].map((id) => this.closeSession(id)));
  }

  private buildServer(instanceId: string, identity: McpIdentity, publicBase: string, closed: AbortSignal): McpServer {
    const rt = () => this.ctx.instances.runtime(instanceId);
    const manifest = rt().manifest;
    const server = new McpServer(
      { name: `synoikia/${rt().slug}`, version: SERVER_VERSION },
      {
        instructions: `${manifest.name} via Synoikia. Use search to discover operations, then execute to call them. When execute returns awaiting_approval, show the link and call resume after the user decides.`,
        capabilities: { extensions: { [MCP_APPS_EXTENSION]: {} } },
      },
    );

    // Approval prompts (design §5.3): URL mode sends the human to our approval page; form mode is only
    // used where the endpoint opted in. `elicitation: {}` from older clients means form support.
    const prompts = (): ClientPrompts | undefined => {
      const caps = server.server.getClientCapabilities()?.elicitation;
      if (!caps) return undefined;
      const timeout = rt().settings.approvalTimeoutMs;
      const out: ClientPrompts = {};
      if (caps.url) {
        out.url = async (req) => {
          const res = await server.server.elicitInput(
            { mode: 'url', elicitationId: req.approvalId, url: `${publicBase}${req.path}`, message: req.message },
            { timeout },
          );
          return { action: res.action };
        };
        out.urlComplete = (approvalId) => {
          void server.server
            .createElicitationCompletionNotifier(approvalId)()
            .catch(() => undefined);
        };
      }
      if (caps.form || !caps.url) {
        out.form = async (req) => {
          const res = await server.server.elicitInput(
            { mode: 'form', message: req.message, requestedSchema: req.requestedSchema },
            { timeout },
          );
          return { action: res.action, content: res.content as { approve?: unknown } | undefined };
        };
      }
      return out;
    };

    const caller = (sessionId: string | undefined): CallerContext => ({
      client: { kind: 'mcp_client', id: identity.label, key: identity.principal },
      mcpSessionId: sessionId,
      principal: { ceiling: identity.access },
      prompts: prompts(),
      parkable: true,
    });
    const extras = (): ToolExtras => ({
      publicBase,
      grant: this.ctx.grants.active(instanceId, identity.principal),
    });

    const run = async (fn: typeof executeCode, code: string, sessionId: string | undefined, request: AbortSignal) => {
      try {
        await this.ctx.instances.ensureFresh(instanceId);
      } catch (err) {
        return toolText({
          ok: false,
          error: { code: 'PLUGIN_UNAVAILABLE', message: err instanceof Error ? err.message : 'Endpoint unavailable' },
          logs: [],
        });
      }
      // A cancelled request or a closed session ends the run: nothing it queued may run afterwards.
      const signal = AbortSignal.any([request, closed]);
      const result = await fn(this.ctx.gateDeps(), rt(), caller(sessionId), code, signal);
      return toolText(result, extras());
    };
    const ui = { ui: { resourceUri: APPROVAL_CARD_URI } };
    const appOnly = { ui: { resourceUri: APPROVAL_CARD_URI, visibility: ['app'] } };
    const executionId = z.string().uuid().describe('The executionId from an awaiting_approval result.');

    const input = {
      code: z
        .string()
        .min(1)
        .max(100_000)
        .describe('Body of an async JavaScript function. Use `return` for the result.'),
    };
    server.registerTool(
      'search',
      {
        title: `Search ${manifest.name}`,
        description: describeSearch(manifest),
        inputSchema: input,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      ({ code }, extra) => run(searchCode, code, extra.sessionId, extra.signal),
    );
    server.registerTool(
      'execute',
      {
        title: `Execute on ${manifest.name}`,
        description: describeExecute(manifest),
        inputSchema: input,
        // Hints for clients that confirm tool calls themselves; the gate never relies on them.
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
        _meta: ui,
      },
      ({ code }, extra) => run(executeCode, code, extra.sessionId, extra.signal),
    );
    server.registerTool(
      'resume',
      {
        title: `Resume on ${manifest.name}`,
        description: describeResume(manifest),
        inputSchema: { executionId },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
        _meta: ui,
      },
      async ({ executionId: id }, extra) => {
        const signal = AbortSignal.any([extra.signal, closed]);
        return toolText(
          await resumeExecution(this.ctx.gateDeps(), rt(), caller(extra.sessionId), id, signal),
          extras(),
        );
      },
    );
    // App-only (design §5.7): the approval card polls state and can end a grant; neither can approve.
    server.registerTool(
      'approval_status',
      {
        title: 'Approval status',
        description: 'State of a parked execution, for the approval card.',
        inputSchema: { executionId },
        annotations: { readOnlyHint: true, openWorldHint: false },
        _meta: appOnly,
      },
      ({ executionId: id }) => {
        const status = this.ctx.executions.status(id, identity.principal, instanceId);
        const body = status ?? { state: 'not_found' };
        return { structuredContent: { ...body }, content: [{ type: 'text', text: JSON.stringify(body) }] };
      },
    );
    server.registerTool(
      'session_grant_revoke',
      {
        title: 'Revoke session approval',
        description: 'Ends the session approval of this client on this endpoint, for the approval card.',
        inputSchema: { grantId: z.string().uuid() },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        _meta: appOnly,
      },
      ({ grantId }) => {
        const grant = this.ctx.grants.get(grantId);
        const mine = grant && grant.instanceId === instanceId && grant.principal === identity.principal;
        const revoked = !!mine && this.ctx.grants.revoke(grantId, { actorKind: 'mcp_client', actorId: identity.label });
        return { content: [{ type: 'text', text: JSON.stringify({ revoked }) }] };
      },
    );
    server.registerResource(
      'approval-card',
      APPROVAL_CARD_URI,
      { title: 'Synoikia approval card', mimeType: MCP_APP_MIME },
      () => ({
        contents: [
          {
            uri: APPROVAL_CARD_URI,
            mimeType: MCP_APP_MIME,
            text: APPROVAL_CARD_HTML,
            _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false } },
          },
        ],
      }),
    );
    return server;
  }

  /** The request carries a bearer or OAuth access token that is live somewhere on this server. */
  private holdsLiveCredential(c: Context): boolean {
    const token = c.req.header('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token) return false;
    return !!this.ctx.tokens.verify(token) || !!this.oauth.verifyAccess(token, '');
  }

  /** Logs why a request was refused (the client gets the generic answer): `warn` for token-shaped
   * credentials, `debug` for bare probes; the reason is a quoted field, never the message. */
  private refused(c: Context, slug: string, status: number, reason: string, fields: LogFields = {}) {
    const ip = clientIp(c, this.ctx.config.TRUST_PROXY);
    const level = presentsCredential(c) ? 'warn' : 'debug';
    const suppressed = this.refusals.admit(`${level}|${ip}|${status}`, Date.now());
    if (suppressed === null) return;
    this.ctx.log[level]('MCP request refused', {
      method: c.req.method,
      slug,
      status,
      reason,
      ...fields,
      ip,
      ua: c.req.header('user-agent'),
      suppressed: suppressed || undefined,
    });
  }

  /** A 4xx/5xx from the MCP transport itself (bad JSON-RPC, wrong Accept header, …), with its message. */
  private async logTransportError(c: Context, slug: string, response: Response, principal: string) {
    if (response.status < 400) return;
    let message = '';
    if (response.headers.get('content-type')?.includes('application/json')) {
      const body = (await response
        .clone()
        .json()
        .catch(() => undefined)) as { error?: { message?: unknown } } | undefined;
      if (typeof body?.error?.message === 'string') message = body.error.message;
    }
    this.ctx.log.warn('MCP request rejected by the transport', {
      method: c.req.method,
      slug,
      status: response.status,
      error: message,
      client: principal,
      accept: c.req.header('accept'),
      ip: clientIp(c, this.ctx.config.TRUST_PROXY),
      ua: c.req.header('user-agent'),
    });
  }

  async handle(c: Context, slug: string): Promise<Response> {
    if (
      !hostAllowed(this.ctx.config, c.req.header('host')) ||
      !originAllowed(this.ctx.config, c.req.header('origin'))
    ) {
      this.refused(c, slug, 403, 'Host or Origin not allowed: add it to PUBLIC_MCP_URL or MCP_ALLOWED_HOSTS', {
        host: c.req.header('host'),
        origin: c.req.header('origin'),
      });
      return c.json(jsonRpcError(-32003, 'Host or Origin not allowed; set PUBLIC_MCP_URL or MCP_ALLOWED_HOSTS'), 403);
    }
    // Before authentication, an unknown slug looks like any endpoint that needs credentials, and a
    // disabled one answers like an enabled one: neither existence nor state is told to strangers.
    const found = this.ctx.instances.bySlug(slug);
    if (!found) {
      this.refused(c, slug, 404, 'no endpoint has this slug');
      if (this.holdsLiveCredential(c)) return c.json(jsonRpcError(-32001, 'Unknown MCP endpoint'), 404);
      c.header('WWW-Authenticate', 'Bearer');
      return c.json({ error: 'unauthorized', error_description: 'Authentication required' }, 401);
    }
    const { instance, plugin } = found;

    const auth = await authenticateMcp(this.ctx, this.oauth, c, instance);
    if (!auth.ok) {
      this.refused(c, slug, auth.status, auth.detail, { mode: effectiveAuthMode(this.ctx, instance.authMode) });
      if (auth.wwwAuthenticate) c.header('WWW-Authenticate', auth.wwwAuthenticate);
      return c.json({ error: auth.error, error_description: auth.message }, auth.status);
    }
    const client = auth.identity.label;
    if (!this.ctx.instances.isServing(instance, plugin)) {
      this.refused(c, slug, 503, 'endpoint or its plugin is disabled', { client });
      return c.json(jsonRpcError(-32002, 'This endpoint is disabled'), 503);
    }

    const sessionId = c.req.header('mcp-session-id');
    if (sessionId) {
      const s = this.sessions.get(sessionId);
      // A session id is only valid for the endpoint and principal that created it.
      if (!s || s.instanceId !== instance.id || s.principal !== auth.identity.principal) {
        // Usually a session that ended (idle, restart): the client is expected to initialize again.
        this.ctx.log.info('MCP request refused: unknown or expired session', {
          method: c.req.method,
          slug,
          status: 404,
          client,
        });
        return c.json(jsonRpcError(-32001, 'Session not found'), 404);
      }
      s.lastSeen = Date.now();
      const response = await s.transport.handleRequest(c.req.raw);
      await this.logTransportError(c, slug, response, client);
      return response;
    }

    if (c.req.method !== 'POST') {
      this.refused(c, slug, 400, 'no Mcp-Session-Id on a non-POST request', { client });
      return c.json(jsonRpcError(-32000, 'Missing Mcp-Session-Id'), 400);
    }
    try {
      await this.ctx.instances.ensureFresh(instance.id, { forceVersionCheck: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.refused(c, slug, 503, 'endpoint unavailable', { client, error: message });
      return c.json(jsonRpcError(-32002, `Endpoint unavailable: ${message}`), 503);
    }

    // One principal can't pile up servers: past the cap, its least recently used session goes.
    const mine = [...this.sessions].filter(([, s]) => s.principal === auth.identity.principal);
    if (mine.length >= MAX_SESSIONS_PER_PRINCIPAL) {
      const [oldest] = mine.sort(([, a], [, b]) => a.lastSeen - b.lastSeen)[0]!;
      await this.closeSession(oldest);
    }
    const closed = new AbortController();
    const server = this.buildServer(instance.id, auth.identity, publicMcpBase(this.ctx, c), closed.signal);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, {
          transport,
          server,
          closed,
          instanceId: instance.id,
          principal: auth.identity.principal,
          lastSeen: Date.now(),
        });
      },
      onsessionclosed: (id) => void this.closeSession(id),
    });
    await server.connect(transport);
    const response = await transport.handleRequest(c.req.raw);
    await this.logTransportError(c, slug, response, client);
    if (!transport.sessionId) {
      // Not a valid initialize request: nothing to keep.
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    } else {
      // Which approval path this client gets (design §5.3): elicitation modes and the MCP Apps card.
      const caps = server.server.getClientCapabilities();
      const elicitation = caps?.elicitation ? (caps.elicitation.url ? 'url' : 'form') : 'none';
      const apps = !!(caps?.extensions as Record<string, unknown> | undefined)?.[MCP_APPS_EXTENSION];
      this.ctx.log.info('MCP session opened', { slug, client, ua: c.req.header('user-agent'), elicitation, apps });
    }
    return response;
  }
}
