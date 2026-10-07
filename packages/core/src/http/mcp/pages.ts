import type { Context } from 'hono';
import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';

/** Server-rendered pages on the MCP port (design §2.1); every value HTML-escaped by `html`, no scripts. */

type Body = HtmlEscapedString | Promise<HtmlEscapedString>;

// Synoikia tokens. The CSP allows no external fonts, so the brand faces apply only when installed
// locally; the stacks fall back to the closest system faces.
const STYLE = `
:root { color-scheme:light; --surface-100:#f7f1e8; --surface-200:#eee4d3; --surface-300:#e4d6bf; --border:#d9c9ab; --border-strong:#c2ac82;
  --ink:#241b12; --ink-muted:#5c5044; --brand:#b5502f; --brand-strong:#8f3d22; --accent:#4f6b52; --on-brand:#fff;
  --link:#8f3d22; --danger:#b23b3b; --danger-text:#9a2f2f; --danger-subtle:#f0dcda;
  --font-display:"Fraunces", Georgia, "Times New Roman", serif; --font-sans:"IBM Plex Sans", system-ui, -apple-system, sans-serif;
  --font-mono:"IBM Plex Mono", ui-monospace, "SF Mono", monospace; }
@media (prefers-color-scheme: dark) { :root { color-scheme:dark; --surface-100:#14110e; --surface-200:#1d1914; --surface-300:#262019;
  --border:#3a3026; --border-strong:#4d4030; --ink:#f2e9db; --ink-muted:#b8ab98; --brand:#d97250; --brand-strong:#e88a63; --accent:#8fae8a;
  --on-brand:#14110e; --link:#d97250; --danger:#e8685f; --danger-text:#e8685f; --danger-subtle:#2e1c1b; } }
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:20px;
  background:var(--surface-100); color:var(--ink); font:15px/1.45 var(--font-sans); padding:16px; }
.brand { display:flex; align-items:center; gap:10px; font-family:var(--font-display); font-weight:600; font-size:23px; line-height:1;
  letter-spacing:-0.01em; } .brand .root { color:var(--brand); } .brand svg { display:block; }
.brand .frame { stroke:var(--ink-muted); } .brand .paths { stroke:var(--brand-strong); } .brand .dwellings { fill:var(--accent); }
.brand .hearth { fill:var(--brand); }
main { width:100%; max-width:460px; background:var(--surface-200); border:1px solid var(--border); border-radius:14px; padding:24px;
  box-shadow:0 1px 2px rgb(36 27 18 / 8%); }
h1 { font-size:22px; line-height:28px; margin:0 0 4px; } p.sub { margin:0 0 18px; color:var(--ink-muted); }
a { color:var(--link); }
label { display:block; font-size:12px; line-height:16px; font-weight:600; color:var(--ink-muted); margin:14px 0 6px; }
input[type=text], input[type=password] { width:100%; padding:8px 12px; border:1px solid var(--border-strong); border-radius:8px; font:inherit;
  background:var(--surface-100); color:inherit; }
input:focus { outline:2px solid var(--brand); outline-offset:-1px; border-color:var(--brand); }
input[type=checkbox], input[type=radio] { accent-color:var(--brand); }
:focus-visible { outline:2px solid var(--brand); outline-offset:2px; }
.row { display:flex; gap:8px; margin-top:18px; } .row > * { flex:1; }
button, a.btn { display:inline-block; text-align:center; padding:8px 16px; border-radius:8px; border:1px solid var(--border-strong);
  background:var(--surface-200); color:var(--ink); font:inherit; font-weight:600; cursor:pointer; text-decoration:none; }
button:hover, a.btn:hover { background:var(--surface-300); }
button.primary { background:var(--brand); border-color:var(--brand); color:var(--on-brand); }
button.primary:hover { background:var(--brand-strong); border-color:var(--brand-strong); } button.danger { color:var(--danger-text); }
.error { color:var(--danger-text); margin:12px 0 0; } .muted { color:var(--ink-muted); font-size:13px; }
ul.endpoints { list-style:none; padding:0; margin:8px 0 0; } ul.endpoints li { padding:8px 0; border-top:1px solid var(--border); }
code, pre { font-family:var(--font-mono); font-size:12px; } pre { white-space:pre-wrap; word-break:break-word; background:var(--surface-100);
  border:1px solid var(--border); border-radius:8px; padding:12px; max-height:260px; overflow:auto; }
.badge { font-size:12px; font-weight:600; padding:2px 10px; border-radius:999px; background:var(--danger-subtle); color:var(--danger-text);
  vertical-align:middle; }
hr { border:none; border-top:1px solid var(--border); margin:18px 0; }
`;

/** The Synoikia mark (design system assets/Logo/synoikia-mark.svg), themed through the classes above. */
const BRAND = `<div class="brand"><svg viewBox="0 0 120 120" width="36" height="36" aria-hidden="true" focusable="false">
<rect class="frame" x="4" y="4" width="112" height="112" rx="24" fill="none" stroke-width="3" opacity="0.32"/>
<g class="paths" stroke-width="4" stroke-linecap="round" opacity="0.55"><line x1="60" y1="60" x2="60" y2="25"/>
<line x1="60" y1="60" x2="95" y2="60"/><line x1="60" y1="60" x2="60" y2="95"/><line x1="60" y1="60" x2="25" y2="60"/></g>
<g class="dwellings"><rect x="52" y="8" width="16" height="16" rx="4"/><rect x="96" y="52" width="16" height="16" rx="4"/>
<rect x="52" y="96" width="16" height="16" rx="4"/><rect x="8" y="52" width="16" height="16" rx="4"/></g>
<rect class="hearth" x="48" y="48" width="24" height="24" rx="6"/></svg><span>Syn<span class="root">oikia</span></span></div>`;

function page(c: Context, title: string, body: Body, status: 200 | 400 | 401 | 403 | 404 | 429 = 200) {
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'",
  );
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-store');
  return c.html(
    html`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>${title} · Synoikia</title>
          <style>
            ${raw(STYLE)}
          </style>
        </head>
        <body>
          ${raw(BRAND)}
          <main>${body}</main>
        </body>
      </html>`,
    status,
  );
}

export function errorPage(c: Context, title: string, message: string, status: 200 | 400 | 403 | 404 = 400) {
  return page(
    c,
    title,
    html`<h1>${title}</h1>
      <p class="sub">${message}</p>`,
    status,
  );
}

export interface LoginView {
  purpose: string;
  continueTo: string;
  csrf: string;
  error?: string;
  localLogin: boolean;
  oidc?: { label: string };
}

export function loginPage(c: Context, v: LoginView, status: 200 | 401 | 403 | 429 = 200) {
  return page(
    c,
    'Sign in',
    html`<h1>Sign in</h1>
      <p class="sub">${v.purpose}</p>
      ${
        v.localLogin
          ? html`<form method="post" action="/oauth/login">
              <input type="hidden" name="csrf" value="${v.csrf}" />
              <input type="hidden" name="continue" value="${v.continueTo}" />
              <label for="u">Username</label
              ><input id="u" type="text" name="username" autocomplete="username" autofocus required />
              <label for="p">Password</label
              ><input id="p" type="password" name="password" autocomplete="current-password" required />
              <div class="row"><button class="primary" type="submit">Sign in</button></div>
            </form>`
          : ''
      }
      ${
        v.oidc
          ? html`${v.localLogin ? html`<hr />` : ''}
              <a class="btn" style="width:100%" href="/oauth/login/oidc?continue=${encodeURIComponent(v.continueTo)}"
                >Sign in with ${v.oidc.label}</a
              >`
          : ''
      }
      ${v.error ? html`<p class="error" role="alert">${v.error}</p>` : ''}`,
    status,
  );
}

export function totpPage(
  c: Context,
  v: { mfa: string; continueTo: string; csrf: string; error?: string },
  status: 200 | 401 = 200,
) {
  return page(
    c,
    'Two-factor code',
    html`<h1>Two-factor code</h1>
      <p class="sub">Enter the code from your authenticator app, or a recovery code.</p>
      <form method="post" action="/oauth/login/totp">
        <input type="hidden" name="csrf" value="${v.csrf}" />
        <input type="hidden" name="mfa" value="${v.mfa}" />
        <input type="hidden" name="continue" value="${v.continueTo}" />
        <label for="code">Code</label
        ><input id="code" type="text" name="code" inputmode="numeric" autocomplete="one-time-code" autofocus required />
        <div class="row"><button class="primary" type="submit">Continue</button></div>
      </form>
      ${v.error ? html`<p class="error" role="alert">${v.error}</p>` : ''}`,
    status,
  );
}

export interface ConsentView {
  clientName: string;
  redirectHost: string;
  username: string;
  endpoints: { resource: string; slug: string; name: string; checked: boolean }[];
  formToken: string;
  /** Pre-selected access ceiling; read-only unless the user picks otherwise. */
  access: 'read' | 'write';
  error?: string;
}

export function consentPage(c: Context, v: ConsentView) {
  return page(
    c,
    'Authorize access',
    html`<h1>Authorize ${v.clientName}</h1>
      <p class="sub">
        Signed in as <strong>${v.username}</strong>. After you approve, you'll be sent to
        <code>${v.redirectHost}</code>.
      </p>
      <form method="post" action="/oauth/consent">
        <input type="hidden" name="form" value="${v.formToken}" />
        <label>Endpoints this client may use</label>
        <ul class="endpoints">
          ${v.endpoints.map(
            (e) =>
              html`<li>
                <label style="display:flex;gap:8px;align-items:center;margin:0;color:inherit;font-weight:500">
                  <input type="checkbox" name="resource" value="${e.resource}" ${e.checked ? 'checked' : ''} />
                  <span><code>/${e.slug}</code> · ${e.name}</span>
                </label>
              </li>`,
          )}
        </ul>
        <label>Access</label>
        <ul class="endpoints">
          <li>
            <label style="display:flex;gap:8px;align-items:center;margin:0;color:inherit;font-weight:500">
              <input type="radio" name="access" value="read" ${v.access === 'write' ? '' : 'checked'} />
              <span><strong>Read only</strong> · this client can never call a write operation</span>
            </label>
          </li>
          <li>
            <label style="display:flex;gap:8px;align-items:center;margin:0;color:inherit;font-weight:500">
              <input type="radio" name="access" value="write" ${v.access === 'write' ? 'checked' : ''} />
              <span
                ><strong>Read &amp; write</strong> · writes allowed where the endpoint's access levels allow them</span
              >
            </label>
          </li>
        </ul>
        <p class="muted">
          Tools still go through the endpoint's access levels and approvals. To change this later, revoke the client
          under Clients & Tokens and connect again.
        </p>
        ${v.error ? html`<p class="error" role="alert">${v.error}</p>` : ''}
        <div class="row">
          <button class="danger" type="submit" name="decision" value="deny">Deny</button>
          <button class="primary" type="submit" name="decision" value="approve">Approve</button>
        </div>
      </form>`,
  );
}

export interface ApprovalView {
  token: string;
  csrf: string;
  username: string;
  slug: string;
  instanceName: string;
  operationKey: string;
  locked: boolean;
  summary: string;
  params: unknown;
  targets: unknown;
  diff: unknown;
  expiresAt: Date;
  confirmLiteral: string | null;
  /** Ask for a TOTP code with the decision (first approval in this browser, or a locked op). */
  needsTotp: boolean;
  /** "Approve for this session" lengths (design §5.8); empty hides the option. */
  grantOptions: { value: string; label: string }[];
  /** The client's audit label, so the approver knows who a session grant covers. */
  client: string | null;
  status: string;
  error?: string;
}

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

export function approvalPage(c: Context, v: ApprovalView, status: 200 | 400 = 200) {
  const open = v.status === 'pending';
  return page(
    c,
    'Approval request',
    html`<h1>${v.operationKey} ${v.locked ? html`<span class="badge">locked</span>` : ''}</h1>
      <p class="sub"><code>/${v.slug}</code> · ${v.instanceName}</p>
      <p>${v.summary}</p>
      ${
        v.targets != null
          ? html`<label>Targets</label>
              <pre>${pretty(v.targets)}</pre>`
          : ''
      }
      ${
        v.diff != null
          ? html`<label>Changes</label>
              <pre>${pretty(v.diff)}</pre>`
          : ''
      }
      <label>Parameters (secrets redacted)</label>
      <pre>${pretty(v.params ?? {})}</pre>
      ${
        open
          ? html`<p class="muted">Signed in as <strong>${v.username}</strong> · expires ${v.expiresAt.toISOString()}</p>
              <form method="post" action="/a/${v.token}">
                <input type="hidden" name="csrf" value="${v.csrf}" />
                ${
                  v.confirmLiteral
                    ? html`<label for="confirm">Type <code>${v.confirmLiteral}</code> to approve</label
                        ><input id="confirm" type="text" name="confirm" autocomplete="off" />`
                    : ''
                }
                ${
                  v.needsTotp
                    ? html`<label for="totp"
                          >Authenticator code${v.locked ? ' (required to approve a locked operation)' : ''}</label
                        ><input
                          id="totp"
                          type="text"
                          name="totp"
                          inputmode="numeric"
                          autocomplete="one-time-code"
                          pattern="[0-9]{6}"
                        />`
                    : ''
                }
                ${v.error ? html`<p class="error" role="alert">${v.error}</p>` : ''}
                <div class="row">
                  <button class="danger" type="submit" name="decision" value="deny">Deny</button>
                  <button
                    class="${v.grantOptions.length ? '' : 'primary'}"
                    type="submit"
                    name="decision"
                    value="approve"
                  >
                    ${v.grantOptions.length ? 'Approve once' : 'Approve'}
                  </button>
                </div>
                ${
                  v.grantOptions.length
                    ? html`<div class="row">
                          <button class="primary" type="submit" name="decision" value="approve_session">
                            Approve for this session
                          </button>
                          <select id="grant" name="grant" aria-label="Session length" style="flex:0 0 auto">
                            ${v.grantOptions.map((o, i) => html`<option value="${o.value}" ${i === 1 ? 'selected' : ''}>${o.label}</option>`)}
                          </select>
                        </div>
                        <p class="muted">
                          Covers every Ask operation of ${v.client ? html`<strong>${v.client}</strong>` : 'this client'}
                          on
                          <code>/${v.slug}</code> for that long, except locked operations and operations that need a
                          typed confirmation. You can revoke it from the chat or the admin portal.
                        </p>`
                    : ''
                }
              </form>`
          : html`<p class="error" role="status">This request is ${v.status.replace('_', ' ')}.</p>`
      }`,
    status,
  );
}
