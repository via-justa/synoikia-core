import type { Context, Hono } from 'hono';
import type { AppContext } from '../../app.js';
import { grantOptions } from '../../approvals/grants.js';
import { mayDecide as ownerMayDecide, needsTotpProof } from '../../approvals/service.js';
import type { ValidSession } from '../../auth/sessions.js';
import { ServiceError } from '../../errors.js';
import { clientIp } from '../common.js';
import { checkUiCsrf, recordTotpProof, renderLogin, uiCsrf, uiSession } from './oauth-routes.js';
import { approvalPage, errorPage } from './pages.js';

/** The approval page (design §5.3): deciding needs a signed-in user with a TOTP proof in this browser
 * (fresh for locked ops) and a CSRF-protected POST, so neither the link holder nor a prefetch decides. */
export function registerApprovalRoutes(app: Hono, ctx: AppContext) {
  const gone = (c: Context) =>
    errorPage(c, 'Link expired', 'This approval request has expired or was already decided.', 404);

  const load = (c: Context, token: string) => {
    const link = ctx.links.resolve(token);
    if (!link) {
      // Tokens are unguessable; this only slows down noisy scanners.
      ctx.throttle.allowIp(clientIp(c, ctx.config.TRUST_PROXY));
      return null;
    }
    const row = ctx.approvals.withDetails(link.approvalId);
    return row ? { link, ...row } : null;
  };
  type Loaded = NonNullable<ReturnType<typeof load>>;

  /** Locked and typed-confirmation operations never get a session grant. */
  const grantsFor = (data: Loaded) =>
    data.op.locked || data.approval.confirmLiteral
      ? []
      : grantOptions(ctx.now(), ctx.instances.settingsOf(data.instance).sessionGrantMaxHours);

  const needsTotp = (session: ValidSession, data: Loaded) =>
    needsTotpProof(data.op.locked, ctx.sessions.sinceTotpProof(session.idHash));

  const noTotp = (c: Context) =>
    errorPage(
      c,
      'Two-factor authentication required',
      'Approving calls needs an authenticator app on your account. Set it up in the admin portal under Profile, then open this link again.',
      403,
    );

  const mayDecide = (session: ValidSession, data: Loaded) =>
    ownerMayDecide(data.approval, session.user.id, ctx.users.isAdmin(session.user));

  const notYours = (c: Context) =>
    errorPage(
      c,
      'Not your request',
      'This approval request belongs to another user. Only the person whose client made the call can decide.',
      403,
    );

  const render = (c: Context, token: string, data: Loaded, session: ValidSession, error?: string) =>
    approvalPage(
      c,
      {
        token,
        csrf: uiCsrf(ctx, c),
        username: session.user.username,
        slug: data.instance.slug,
        instanceName: data.instance.displayName,
        operationKey: data.op.key,
        locked: data.op.locked,
        summary: data.approval.summary,
        params: data.approval.paramsDisplay,
        targets: data.approval.resolvedTargets,
        diff: data.approval.diff,
        expiresAt: data.approval.expiresAt,
        confirmLiteral: data.approval.confirmLiteral,
        needsTotp: needsTotp(session, data),
        grantOptions: grantsFor(data).map(({ value, label }) => ({ value, label })),
        client: data.approval.clientId,
        status: data.approval.status,
        error,
      },
      error ? 400 : 200,
    );

  app.get('/a/:token', (c) => {
    const token = c.req.param('token');
    const data = load(c, token);
    if (!data) return gone(c);
    const session = uiSession(ctx, c, 'approval');
    if (!session) return renderLogin(ctx, c, `/a/${token}`, 'Sign in to review this approval request.');
    if (!mayDecide(session, data)) return notYours(c);
    if (!session.user.totpEnabled) return noTotp(c);
    return render(c, token, data, session);
  });

  app.post('/a/:token', async (c) => {
    const token = c.req.param('token');
    const body = await c.req.parseBody();
    const data = load(c, token);
    if (!data) return gone(c);
    const session = uiSession(ctx, c, 'approval');
    if (!session) return renderLogin(ctx, c, `/a/${token}`, 'Your sign-in expired. Sign in again to decide.');
    if (!mayDecide(session, data)) return notYours(c);
    if (!session.user.totpEnabled) return noTotp(c);
    if (!checkUiCsrf(c, body.csrf)) return render(c, token, data, session, 'The form expired; try again.');
    const approve = body.decision === 'approve' || body.decision === 'approve_session';
    if (!approve && body.decision !== 'deny') return render(c, token, data, session, 'Choose approve or deny.');
    let sessionGrantUntil: Date | undefined;
    if (body.decision === 'approve_session') {
      sessionGrantUntil = grantsFor(data).find((o) => o.value === body.grant)?.until;
      if (!sessionGrantUntil) return render(c, token, data, session, 'Choose a session length.');
    }

    if (approve && needsTotp(session, data)) {
      const user = session.user;
      if (ctx.throttle.lockedFor(user.username, 'mcp') > 0)
        return render(c, token, data, session, 'Too many attempts; try again later.');
      // TOTP only: a recovery code typed here must neither count nor be used up.
      if (!ctx.users.verifyTotpCode(user.id, String(body.totp ?? ''))) {
        if (ctx.throttle.fail(user.username, 'mcp'))
          ctx.events.emit('auth.lockout', {
            username: user.username,
            ip: clientIp(c, ctx.config.TRUST_PROXY),
            surface: 'mcp',
          });
        return render(c, token, data, session, 'Enter a valid authenticator code to approve.');
      }
      ctx.throttle.succeed(user.username, 'mcp');
      recordTotpProof(ctx, session.idHash);
    }

    try {
      ctx.approvals.decide(data.approval.id, {
        approve,
        confirm: typeof body.confirm === 'string' ? body.confirm : undefined,
        decidedBy: session.user.username,
        sessionGrantUntil,
      });
    } catch (err) {
      if (err instanceof ServiceError) return render(c, token, data, session, err.message);
      throw err;
    }
    const granted = sessionGrantUntil
      ? ` Ask operations of this client on /${data.instance.slug} run without asking until ${sessionGrantUntil.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
      : '';
    return errorPage(
      c,
      approve ? 'Approved' : 'Denied',
      `${data.op.key} on /${data.instance.slug} was ${approve ? 'approved' : 'denied'}.${granted} You can close this page; your chat continues by itself.`,
      200,
    );
  });
}
