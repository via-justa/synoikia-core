import { ErrorCodes, PluginError } from './errors.js';

/** Base URLs for plugin connections: only the given schemes, credentials dropped. */

export interface ParsedBaseUrl {
  url: URL;
  /** The base URL's path without a trailing slash (`''` for the root). */
  path: string;
}

/** Parses `baseUrl`, failing with `INVALID_PARAMS` on a malformed URL or a scheme not in `schemes`. */
export function parseBaseUrl(baseUrl: string, schemes: readonly string[] = ['http:', 'https:']): ParsedBaseUrl {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new PluginError(ErrorCodes.InvalidParams, 'baseUrl is not a valid URL');
  }
  if (!schemes.includes(url.protocol))
    throw new PluginError(ErrorCodes.InvalidParams, `Unsupported URL scheme ${url.protocol}`);
  return { url, path: url.pathname.replace(/\/+$/, '') };
}

/** `https://host:8123/sub/` + `/api` → `https://host:8123/sub/api` (ws(s) with `websocket`). */
export function joinApiPath(baseUrl: string, suffix: string, opts: { websocket?: boolean } = {}): string {
  const { url, path } = parseBaseUrl(baseUrl, opts.websocket ? ['http:', 'https:', 'ws:', 'wss:'] : undefined);
  let protocol = url.protocol;
  if (opts.websocket) protocol = protocol === 'https:' || protocol === 'wss:' ? 'wss:' : 'ws:';
  return `${protocol}//${url.host}${path}${suffix}`;
}
