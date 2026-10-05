import { describe, expect, it } from 'vitest';
import { createLogger, formatLine } from '../src/log.js';
import type { LogLevel } from '../src/log.js';

describe('logger', () => {
  it('drops lines below LOG_LEVEL', () => {
    const lines: [LogLevel, string][] = [];
    const log = createLogger('warn', (line, level) => lines.push([level, line]));
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(lines).toEqual([
      ['warn', 'WARN w'],
      ['error', 'ERROR e'],
    ]);
  });

  it('quotes values that could forge fields or lines, and skips empty ones', () => {
    const line = formatLine('info', 'msg', {
      slug: 'echo',
      status: 401,
      ua: 'evil\nWARN forged ip=1.2.3.4',
      host: 'a b',
      none: undefined,
      empty: '',
    });
    expect(line).toBe('INFO msg slug=echo status=401 ua="evil\\nWARN forged ip=1.2.3.4" host="a b"');
    expect(line).not.toContain('\n');
  });

  it('clips long values', () => {
    expect(formatLine('info', 'm', { v: 'x'.repeat(500) }).length).toBeLessThan(320);
  });
});
