import { Hono } from 'hono';
import type { AppContext } from '../app.js';
import { clientIp, errorResponse } from './common.js';
import { McpEndpoints } from './mcp/endpoint.js';
import { registerApprovalRoutes } from './mcp/approval-routes.js';
import { registerOAuthRoutes } from './mcp/oauth-routes.js';

const jsonRpcError = (code: number, message: string) => ({
  jsonrpc: '2.0' as const,
  id: null,
  error: { code, message },
});

/** The public MCP listener (design §2.1): endpoints, OAuth and approval pages; no Admin API here. */
export function createMcpApp(ctx: AppContext): Hono {
  const app = new Hono();
  app.onError(errorResponse);
  // LOG_LEVEL=debug: one line per request, so a client's discovery and sign-in steps can be followed.
  // The path only: query strings carry OAuth state and PKCE values.
  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    ctx.log.debug('MCP listener request', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Date.now() - started,
      ip: clientIp(c, ctx.config.TRUST_PROXY),
      ua: c.req.header('user-agent'),
    });
  });
  const endpoints = new McpEndpoints(ctx, ctx.oauth);
  ctx.onStop(() => endpoints.closeAll());

  // Aggregate status only; per-instance detail lives on the admin port (design §11).
  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  registerOAuthRoutes(app, ctx, ctx.oauth);
  registerApprovalRoutes(app, ctx);
  app.all('/.well-known/*', (c) => c.json({ error: 'not_found' }, 404));
  app.all('/oauth/*', (c) => c.json({ error: 'not_found' }, 404));

  app.all('/:slug', (c) => endpoints.handle(c, c.req.param('slug')));

  app.notFound((c) => c.json(jsonRpcError(-32001, 'Not found'), 404));
  return app;
}
