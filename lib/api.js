// The one HTTP helper ravensight-doctor uses to talk to the Ravensight API.

import { printable } from './printable.js';

const DEFAULT_TIMEOUT_MS = 10_000;

/** Join an API base URL and a path. */
export function apiUrl(base, path) {
  return base.replace(/\/+$/, '') + path;
}

/**
 * Make one JSON request. Never throws. Returns
 *   { reached: true, status, body, url }   when the server answered
 *   { reached: false, error, url }         on a network error or timeout
 * body is the parsed JSON response or null.
 */
export async function apiRequest(base, method, path, { headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = apiUrl(base, path);
  const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const error =
      err && (err.name === 'TimeoutError' || err.name === 'AbortError')
        ? `no answer within ${Math.round(timeoutMs / 1000)} s`
        : (err && err.cause && (err.cause.code || err.cause.message)) || (err && err.message) || 'network error';
    return { reached: false, error, url };
  }
  let parsed = null;
  try {
    const text = await res.text();
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { reached: true, status: res.status, body: parsed, url };
}

/**
 * The server's error code or message from a response body, if any, made
 * printable (see printable.js): it is only ever embedded in text the doctor
 * prints.
 */
export function serverSaid(body) {
  if (body && typeof body === 'object' && (body.error || body.message)) return printable(body.error || body.message);
  return '';
}
