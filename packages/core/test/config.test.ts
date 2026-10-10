import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { loadConfig } from '../src/config/env.js';
import { clientIp, errorResponse } from '../src/http/common.js';
import { createLogger, type LogLevel } from '../src/log.js';
import { isValidSlug, RESERVED_SLUGS } from '../src/endpoints/slug.js';

describe('loadConfig', () => {
  it('defaults to MCP 8080 and admin 8081', () => {
    const c = loadConfig({});
    expect(c.MCP_PORT).toBe(8080);
    expect(c.ADMIN_PORT).toBe(8081);
    expect(c.TRUST_PROXY).toBe(0);
  });

  it('reads TRUST_PROXY as a hop count', () => {
    expect(loadConfig({ TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(1);
    expect(loadConfig({ TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    expect(loadConfig({ TRUST_PROXY: '2' }).TRUST_PROXY).toBe(2);
    expect(loadConfig({ TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(0);
    expect(() => loadConfig({ TRUST_PROXY: 'yes' })).toThrow(/hop count/);
  });

  it('refuses to put MCP and admin on the same port', () => {
    expect(() => loadConfig({ MCP_PORT: '9000', ADMIN_PORT: '9000' })).toThrow(/must differ/);
  });

  it('validates public URLs', () => {
    expect(loadConfig({ PUBLIC_MCP_URL: 'https://mcp.example.com' }).PUBLIC_MCP_URL).toBe('https://mcp.example.com');
    expect(loadConfig({ PUBLIC_MCP_URL: '' }).PUBLIC_MCP_URL).toBeUndefined();
    expect(() => loadConfig({ PUBLIC_MCP_URL: 'not a url' })).toThrow();
  });
});

describe('isValidSlug', () => {
  it.each(['acme', 'acme-cabin', 'widgets', 'acme2'])('accepts %s', (slug) => {
    expect(isValidSlug(slug)).toBe(true);
  });

  it.each(['', 'ACME', '-acme', 'acme_cabin', 'a/b', 'x'.repeat(64), ...RESERVED_SLUGS])('rejects %s', (slug) => {
    expect(isValidSlug(slug)).toBe(false);
  });
});

describe('clientIp', () => {
  const ipOf = async (trust: number, xff?: string) => {
    const app = new Hono().get('/', (c) => c.text(clientIp(c, trust) ?? 'none'));
    return (await app.request('/', { headers: xff ? { 'x-forwarded-for': xff } : {} })).text();
  };

  it('takes the address the trusted proxy appended, not what the client sent', async () => {
    // The client forged the first entry; the one proxy appended the real peer.
    expect(await ipOf(1, '6.6.6.6, 203.0.113.9')).toBe('203.0.113.9');
    expect(await ipOf(1, '203.0.113.9')).toBe('203.0.113.9');
    // Two chained proxies: the second-to-last entry is what the outer one saw.
    expect(await ipOf(2, '6.6.6.6, 203.0.113.9, 10.0.0.2')).toBe('203.0.113.9');
    // Untrusted: the header is ignored.
    expect(await ipOf(0, '6.6.6.6')).toBe('none');
  });
});

describe('errorResponse', () => {
  it('logs an unexpected error through the logger, by route pattern, and answers a bare 500', async () => {
    const lines: [LogLevel, string][] = [];
    const log = createLogger('debug', (line, level) => lines.push([level, line]));
    const app = new Hono();
    app.onError((err, c) => errorResponse(err, c, log));
    app.get('/a/:token', () => {
      throw new Error('boom');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await app.request('/a/secret-link-token');
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal', message: 'Internal error' });
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
    expect(lines).toHaveLength(1);
    const [level, line] = lines[0]!;
    expect(level).toBe('error');
    expect(line).toMatch(/^ERROR request failed method=GET route=\/a\/:token error="Error: boom/);
    expect(line).not.toContain('secret-link-token');
  });
});
