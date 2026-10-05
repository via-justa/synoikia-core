/**
 * Plain-text server log on stdout/stderr, filtered by LOG_LEVEL (design §11). One line per event:
 * `LEVEL message key=value …`. Callers never pass credentials (tokens, assertions, secrets) as fields;
 * client-supplied values (Host, User-Agent) are quoted, so they can't forge extra lines or fields.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const MAX_VALUE = 300;

function formatValue(value: string | number | boolean): string {
  const text = String(value);
  const clipped = text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}…` : text;
  return /^[\w.:/@+,=-]+$/.test(clipped) ? clipped : JSON.stringify(clipped);
}

export function formatLine(level: LogLevel, message: string, fields: LogFields = {}): string {
  // Messages are meant to be constant; anything variable belongs in a field. Escaped all the same.
  const parts = [level.toUpperCase(), /^[\x20-\x7e]*$/.test(message) ? message : JSON.stringify(message)];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${key}=${formatValue(value)}`);
  }
  return parts.join(' ');
}

export function createLogger(
  level: LogLevel,
  write: (line: string, level: LogLevel) => void = (line, l) =>
    (l === 'warn' || l === 'error' ? console.error : console.log)(line),
): Logger {
  const min = LOG_LEVELS.indexOf(level);
  const at =
    (l: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      if (LOG_LEVELS.indexOf(l) >= min) write(formatLine(l, message, fields), l);
    };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}
