export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export function ago(value: string | Date | null | undefined, now = Date.now()): string {
  if (!value) return 'never';
  const d = typeof value === 'string' ? new Date(value) : value;
  const s = Math.round((now - d.getTime()) / 1000);
  if (s < 0) return `in ${until(d, now)}`;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function until(value: string | Date, now = Date.now()): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  const s = Math.max(0, Math.round((d.getTime() - now) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export const pretty = (v: unknown) => JSON.stringify(v, null, 2);

export const AUTH_MODE_LABELS: Record<string, string> = {
  external: 'External (proxy)',
  bearer: 'Bearer token',
  oauth: 'OAuth',
  'bearer+oauth': 'Bearer or OAuth',
};

export const REASON_LABELS: Record<string, string> = {
  level_none: 'Off',
  token_read_only: 'Read-only connection',
  locked_not_opted_in: 'Locked — not enabled',
  level_write: 'Auto-approved at Write',
  group_missing: 'No group',
  not_in_role: 'Not in your role',
  unknown_operation: 'Unknown',
};

export const LEVEL_LABELS: Record<string, string> = { none: 'None', read: 'Read', ask: 'Ask', write: 'Write' };

/** One line per level, shown as the control's tooltip and in help text. */
export const LEVEL_HELP: Record<string, string> = {
  none: 'Nothing is callable',
  read: 'Reads run; writes are off',
  ask: 'Reads run; every write asks for approval (pre-approval rules can cover some)',
  write: 'Reads run; writes run without asking (locked operations still ask)',
};

/** What an operation's own level means, by kind (shown as the tooltip on its level control). */
export const OP_LEVEL_HELP: Record<'read' | 'write' | 'locked', Record<string, string>> = {
  read: { none: 'Off', read: 'Runs', ask: 'Every call asks for approval' },
  write: { none: 'Off', ask: 'Every call asks for approval', write: 'Runs without asking' },
  locked: {
    none: 'Off',
    ask: 'Every call asks for approval, with a typed confirmation',
    write: 'Locked operations always ask',
  },
};

/** Where an operation's read/write type came from, from the plugin's classification reason. */
export function kindSource(reason: string | null | undefined, locked: boolean): string {
  if (locked) return 'Locked: destructive or irreversible, so it always needs a human';
  if (!reason) return '';
  const role = /^roles:(?:read|write)\((.+)\)$/.exec(reason);
  if (role) return `Requires ${role[1]}`;
  const verb = /^verb:([A-Z]+)$/.exec(reason);
  if (verb) return `HTTP ${verb[1]}`;
  const naming = /^naming:(read|write)\((.+)\)$/.exec(reason);
  if (naming) return `Named like a ${naming[1]} (${naming[2]})`;
  if (reason === 'default:ambiguous') return 'Not recognised, so treated as a write';
  return reason;
}
