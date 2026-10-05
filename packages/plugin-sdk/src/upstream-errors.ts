import { ErrorCodes, PluginError } from './errors.js';

/** Maps upstream failures to core's error codes; messages name the operation, never its params. */

export type UpstreamErrorKind = 'denied' | 'invalid' | 'failed';

const MAX_MESSAGE = 300;

/** Shortens an upstream message to `max` characters, marking the cut with `…`. */
export function clip(message: string, max = MAX_MESSAGE): string {
  return message.length > max ? `${message.slice(0, max)}…` : message;
}

/** The kind of an HTTP error status: 401/403 denied, 400/422 invalid, anything else failed. */
export function statusKind(status: number): UpstreamErrorKind {
  if (status === 401 || status === 403) return 'denied';
  if (status === 400 || status === 422) return 'invalid';
  return 'failed';
}

/** `denied` → UPSTREAM_DENIED, `invalid` → INVALID_PARAMS, `failed` → UPSTREAM_ERROR. */
export function upstreamError(
  service: string,
  kind: UpstreamErrorKind,
  label: string,
  message: string,
  data?: unknown,
): PluginError {
  const text = clip(message);
  if (kind === 'denied')
    return new PluginError(
      ErrorCodes.UpstreamDenied,
      `${service} denied ${label}: insufficient permission (${text})`,
      data,
    );
  if (kind === 'invalid') return new PluginError(ErrorCodes.InvalidParams, `${label}: ${text}`, data);
  return new PluginError(ErrorCodes.UpstreamError, `${label}: ${text}`, data);
}
