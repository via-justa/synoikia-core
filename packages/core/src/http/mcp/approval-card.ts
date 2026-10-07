/** The approval card (design §5.7): an MCP Apps view that hosts render for `execute` and `resume` results.
 * It shows state and opens the approval page; it never decides. Static, no external origins. */

export const APPROVAL_CARD_URI = 'ui://synoikia/approval';
export const MCP_APP_MIME = 'text/html;profile=mcp-app';
export const MCP_APPS_EXTENSION = 'io.modelcontextprotocol/ui';

export const APPROVAL_CARD_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root { color-scheme: light; --bg:#eee4d3; --line:#d9c9ab; --ink:#241b12; --muted:#5c5044; --brand:#b5502f; --brand-strong:#8f3d22;
  --on-brand:#fff; --ok:#3f6b45; --ok-bg:#dfe9dc; --warn:#8a6514; --warn-bg:#f3e6c4; --no:#9a2f2f; --no-bg:#f0dcda;
  --sans:"IBM Plex Sans", system-ui, -apple-system, sans-serif; --mono:"IBM Plex Mono", ui-monospace, monospace; }
:root[data-theme="dark"] { color-scheme: dark; --bg:#1d1914; --line:#3a3026; --ink:#f2e9db; --muted:#b8ab98; --brand:#d97250;
  --brand-strong:#e88a63; --on-brand:#14110e; --ok:#8fbf8f; --ok-bg:#1f2a1f; --warn:#e0b860; --warn-bg:#2c2414; --no:#e8685f; --no-bg:#2e1c1b; }
* { box-sizing: border-box; }
html, body { margin: 0; background: transparent; color: var(--ink); font: 14px/1.45 var(--sans); }
.card { border: 1px solid var(--line); border-radius: 12px; background: var(--bg); overflow: hidden; }
.hd { padding: 8px 12px; border-bottom: 1px solid var(--line); font-size: 11px; font-weight: 600; letter-spacing: .06em;
  text-transform: uppercase; color: var(--muted); }
.bd { padding: 12px; display: grid; gap: 8px; }
.t { font-weight: 600; font-size: 15px; overflow-wrap: anywhere; }
.op { font: 12px/1.4 var(--mono); color: var(--muted); overflow-wrap: anywhere; }
.ft { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
.pill { font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 999px; }
.pending { background: var(--warn-bg); color: var(--warn); } .ok { background: var(--ok-bg); color: var(--ok); }
.no { background: var(--no-bg); color: var(--no); }
button { font: 600 13px/1.2 var(--sans); padding: 7px 14px; border-radius: 8px; border: 1px solid var(--brand); cursor: pointer;
  background: var(--brand); color: var(--on-brand); }
button:hover { background: var(--brand-strong); }
button.quiet { background: transparent; color: var(--no); border-color: var(--line); padding: 4px 10px; font-size: 12px; }
.grant { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 12px; border: 1px solid var(--line);
  border-radius: 10px; background: var(--ok-bg); color: var(--ok); font-size: 12.5px; }
.grant button { margin-left: auto; }
.note { font-size: 12px; color: var(--muted); }
[hidden] { display: none !important; }
</style></head>
<body>
<div id="root" hidden></div>
<script>
(() => {
  const root = document.getElementById('root');
  let nextId = 1;
  const waiting = new Map();
  const send = (msg) => window.parent.postMessage(Object.assign({ jsonrpc: '2.0' }, msg), '*');
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      send({ id, method, params });
    });
  const notify = (method, params) => send({ method, params: params || {} });
  const resize = () => notify('ui/notifications/size-changed', { height: root.hidden ? 0 : document.body.scrollHeight });
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const payloadOf = (res) => {
    if (res && res.structuredContent) return res.structuredContent;
    const text = res && Array.isArray(res.content) ? res.content.find((c) => c.type === 'text') : null;
    try { return text ? JSON.parse(text.text) : null; } catch { return null; }
  };
  const timeLeft = (iso) => {
    const ms = new Date(iso).getTime() - Date.now();
    if (!(ms > 0)) return 'expired';
    const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
    return 'expires in ' + m + ':' + String(s).padStart(2, '0');
  };

  let state = null;
  let poll = null;
  let told = false;

  function render() {
    if (!state || (!state.approval && !state.grant)) { root.hidden = true; resize(); return; }
    root.hidden = false;
    let html = '';
    if (state.approval) {
      const a = state.approval;
      const st = state.status || 'pending';
      const pill = st === 'pending'
        ? '<span class="pill pending" id="left">● ' + esc(timeLeft(a.expiresAt)) + '</span>'
        : st === 'approved' || (st === 'done' && state.decision === 'approved')
          ? '<span class="pill ok">✓ Approved' + (state.decidedBy ? ' by ' + esc(state.decidedBy) : '') + '</span>'
          : st === 'running' ? '<span class="pill ok">Running</span>'
          : '<span class="pill no">✕ ' + esc(st === 'done' ? (state.decision || 'finished').replace('_', ' ') : st.replace('_', ' ')) + '</span>';
      html += '<div class="card"><div class="hd">Synoikia · approval needed</div><div class="bd">' +
        '<div class="t">' + esc(a.summary) + '</div><div class="op">' + esc(a.operationKey) + '</div>' +
        '<div class="ft">' + pill + (st === 'pending' ? '<button id="open" type="button">Review and approve ↗</button>' : '') + '</div>' +
        (st === 'pending' ? '<div class="note">Approve or deny on the Synoikia page. This chat continues by itself after you decide.</div>' : '') +
        '</div></div>';
    }
    if (state.grant) {
      html += '<div class="grant" style="margin-top:' + (state.approval ? '8px' : '0') + '">✓ Session approval active until ' +
        esc(new Date(state.grant.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) +
        ' <button class="quiet" id="revoke" type="button">Revoke</button></div>';
    }
    root.innerHTML = html;
    const open = document.getElementById('open');
    if (open) open.onclick = () => request('ui/open-link', { url: state.approval.url }).catch(() => {});
    const revoke = document.getElementById('revoke');
    if (revoke) revoke.onclick = () =>
      request('tools/call', { name: 'session_grant_revoke', arguments: { grantId: state.grant.id } })
        .then(() => { state.grant = null; render(); }).catch(() => {});
    resize();
  }

  async function tell(text) {
    if (told) return;
    told = true;
    try { await request('ui/message', { role: 'user', content: [{ type: 'text', text }] }); }
    catch {
      try { await request('ui/message', { role: 'user', content: { type: 'text', text } }); }
      catch { const n = document.createElement('div'); n.className = 'note'; n.textContent = 'Say "continue" in the chat to get the result.'; root.appendChild(n); resize(); }
    }
  }

  async function check() {
    if (!state || !state.executionId || !state.approval) return;
    let s;
    try { s = payloadOf(await request('tools/call', { name: 'approval_status', arguments: { executionId: state.executionId } })); }
    catch { return; }
    if (!s || !s.state) return;
    if (s.state === 'pending') { const left = document.getElementById('left'); if (left) left.textContent = '● ' + timeLeft(state.approval.expiresAt); return; }
    state.status = s.state; state.decision = s.decision || s.state; state.decidedBy = s.decidedBy;
    clearInterval(poll); poll = null;
    render();
    const approved = s.state === 'approved' || s.state === 'running' || (s.state === 'done' && s.decision === 'approved');
    tell(approved ? 'Approved, continue.' : 'The approval was ' + String(state.decision).replace('_', ' ') + '. Continue.');
  }

  function onResult(res) {
    const p = payloadOf(res) || {};
    state = { executionId: p.executionId, approval: p.status === 'awaiting_approval' ? p.approval : null, grant: p.sessionGrant || null, status: 'pending' };
    told = false;
    render();
    if (poll) clearInterval(poll);
    if (state.approval) poll = setInterval(check, 2000);
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window.parent) return;
    const m = ev.data;
    if (!m || m.jsonrpc !== '2.0') return;
    if (m.id != null && waiting.has(m.id) && !m.method) {
      const w = waiting.get(m.id); waiting.delete(m.id);
      if (m.error) w.reject(m.error); else w.resolve(m.result);
      return;
    }
    if (m.method === 'ui/notifications/tool-result') onResult(m.params);
    if (m.method === 'ui/notifications/host-context-changed' && m.params && m.params.theme)
      document.documentElement.dataset.theme = m.params.theme;
  });

  request('ui/initialize', { appInfo: { name: 'synoikia-approval', version: '1' }, appCapabilities: {}, protocolVersion: '2026-01-26' })
    .then((r) => {
      const theme = r && r.hostContext && r.hostContext.theme;
      document.documentElement.dataset.theme = theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      notify('ui/notifications/initialized');
    })
    .catch(() => {});
})();
</script>
</body></html>`;
