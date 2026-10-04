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
import type { McpIdentity } from '../../auth/mcp-auth.js';
import type { OAuthService } from '../../auth/oauth.js';
import type { CallerContext } from '../../gate/pipeline.js';
import { executeCode, searchCode } from '../../runtime/index.js';
import type { SandboxResult } from '../../sandbox/index.js';
import type { LogFields } from '../../log.js';
import { clientIp } from '../common.js';

/**
 * `/{slug}` Streamable HTTP endpoints (design §2.2): one McpServer + transport per MCP session,
 * bound to its instance and authenticated principal, exposing exactly `search` and `execute`.
 */

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

function toolText(result: SandboxResult) {
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
  return { content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }] };
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
    'Reads run immediately. Writes either run straight away or pause until a human approves them on an approval page the client is asked to open (see `approval` in catalog entries); denials and other refusals throw an Error with `err.code` (e.g. OPERATION_DISABLED, PERMISSION_DENIED, UPSTREAM_ERROR) that your code can catch.',
    'Calls run one at a time. There is no network, filesystem or timer access. Secrets in results are redacted.',
  ].join('\n');
}

/**
 * DNS-rebinding defence (MCP transport spec): a browser page can make its own domain resolve to this
 * server, but it can't change the Host it sends, nor the Origin. Host must be a name this server was
 * configured for (PUBLIC_MCP_URL, MCP_ALLOWED_HOSTS) or something that can't be rebound (localhost, an
 * IP literal); an Origin, when present, must be one of those too.
 */
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

export class McpEndpoints {
  private readonly sessions = new Map<string, Session>();
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
        instructions: `${manifest.name} via Synoikia. Use search to discover operations, then execute to call them.`,
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
    });

    const run = async (fn: typeof searchCode, code: string, sessionId: string | undefined, request: AbortSignal) => {
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
      return toolText(await fn(this.ctx.gateDeps(), rt(), caller(sessionId), code, signal));
    };

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
      },
      ({ code }, extra) => run(executeCode, code, extra.sessionId, extra.signal),
    );
    return server;
  }

  /** The request carries a bearer or OAuth access token that is live somewhere on this server. */
  private holdsLiveCredential(c: Context): boolean {
    const token = c.req.header('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token) return false;
    return !!this.ctx.tokens.verify(token) || !!this.oauth.verifyAccess(token, '');
  }

  /**
   * Why a request was refused, on the server log only (the client gets the generic answer). Requests
   * that presented credentials are `warn`: someone is trying to connect and failing. Bare probes
   * (scanners, a client's first unauthenticated step of OAuth discovery) are `debug`.
   */
  private refused(c: Context, slug: string, status: number, reason: string, fields: LogFields = {}) {
    const credentials = !!c.req.header('authorization') || !!c.req.header('cf-access-jwt-assertion');
    this.ctx.log[credentials ? 'warn' : 'debug'](`MCP request refused: ${reason}`, {
      method: c.req.method,
      slug,
      status,
      ...fields,
      ip: clientIp(c, this.ctx.config.TRUST_PROXY),
      ua: c.req.header('user-agent'),
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
      this.ctx.log.warn(
        'MCP request refused: Host or Origin not allowed; add it to PUBLIC_MCP_URL or MCP_ALLOWED_HOSTS',
        {
          method: c.req.method,
          slug,
          status: 403,
          host: c.req.header('host'),
          origin: c.req.header('origin'),
          ip: clientIp(c, this.ctx.config.TRUST_PROXY),
        },
      );
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
      this.ctx.log.info('MCP session opened', { slug, client, ua: c.req.header('user-agent') });
    }
    return response;
  }
}
