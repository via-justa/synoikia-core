import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import type { AppContext } from '../app.js';
import { csrfGuard, registerAuthRoutes, registerProfileRoutes, requireAdmin, requireUser } from './admin/auth.js';
import type { AdminEnv } from './admin/auth.js';
import { registerInstanceRoutes } from './admin/instances.js';
import { registerMeRoutes } from './admin/me.js';
import { registerRoleRoutes } from './admin/roles.js';
import { registerSystemRoutes } from './admin/system.js';
import { errorResponse } from './common.js';

export interface AdminAppOptions {
  /** Built admin-ui assets. The SPA is optional so the API can run without a UI build (tests, dev). */
  uiDir?: string;
}

/** The only API paths a non-admin may use; every other route is admin-only by default. */
const EVERY_USER = ['/api/session', '/api/setup', '/api/profile', '/api/me'];

/** Paths the SPA fallback must never swallow, so API/auth typos surface as 404s. */
const NON_SPA_PREFIXES = ['/api', '/auth', '/.well-known', '/healthz'];

/** The LAN-only admin listener (design §2.1): Vue SPA + Admin API + login/OIDC. */
export function createAdminApp(ctx: AppContext, { uiDir }: AdminAppOptions = {}): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();
  app.onError(errorResponse);

  // The SPA loads only its own bundle; nothing may frame the portal (clickjacking on approvals).
  app.use('*', async (c, next) => {
    await next();
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
        "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    c.header('X-Frame-Options', 'DENY');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
  });

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  app.use('/api/*', csrfGuard(ctx));
  app.use('/auth/*', csrfGuard(ctx));
  registerAuthRoutes(app, ctx); // public: session probe, setup, login, OIDC

  // Everything else under /api needs a signed-in user, and is admin-only unless listed (design §8.4).
  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/session' || c.req.path === '/api/setup') return next();
    return requireUser(ctx)(c, next);
  });
  app.use('/api/*', async (c, next) => {
    if (EVERY_USER.some((p) => c.req.path === p || c.req.path.startsWith(`${p}/`))) return next();
    return requireAdmin(ctx)(c, next);
  });
  registerProfileRoutes(app, ctx);
  registerMeRoutes(app, ctx);
  registerRoleRoutes(app, ctx);
  registerInstanceRoutes(app, ctx);
  registerSystemRoutes(app, ctx);
  app.all('/api/*', (c) => c.json({ error: 'not_found', message: 'No such API route' }, 404));

  const indexHtml = uiDir ? path.join(uiDir, 'index.html') : undefined;
  if (uiDir && indexHtml && existsSync(indexHtml)) {
    const html = readFileSync(indexHtml, 'utf8');
    app.use('/assets/*', serveStatic({ root: path.relative(process.cwd(), uiDir) }));
    app.get('*', (c, next) => {
      if (NON_SPA_PREFIXES.some((p) => c.req.path === p || c.req.path.startsWith(`${p}/`))) return next();
      return c.html(html);
    });
  }

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  return app;
}
