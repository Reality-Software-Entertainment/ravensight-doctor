// The --live check: send one real event through the API with the project's
// ingest key and confirm the server stored it.
//
// 1. GET  /api/v1/settings              (X-API-Key) 401 bad key, trackingEnabled false stops
// 2. POST /api/v1/session               (X-API-Key) platform "doctor"
// 3. POST /api/v1/track/batch           (X-Session-Token) one ravensight_doctor_ping
// 4. GET  /api/v1/doctor/ping/:nonce    (X-API-Key) polled until found or the time is up
//
// The server picks the doctor session's device id, limits it to the one ping
// event, and keeps it out of analytics and quota. A server that predates the
// read back answers 404 to step 4, which reads the same as a timeout.
//
// Steps 1 to 3 are each tried once more, after 3 seconds, when the first
// answer is a 5xx or no answer at all (an API restart, a load balancer
// hiccup). A 4xx is never retried. Step 4 is already a poll, so it is not.

import crypto from 'node:crypto';
import { apiRequest, serverSaid } from './api.js';

export const PING_EVENT = 'ravensight_doctor_ping';
const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_ATTEMPTS = 10;
const DEFAULT_RETRY_DELAY_MS = 3000;

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** Is this answer worth one more try: a network error or a 5xx? Never a 4xx. */
function transient(res) {
  return !res.reached || res.status >= 500;
}

function unreachable(res) {
  return `could not reach ${res.url} (${res.error}). Check your network and the --api-url value.`;
}

function unexpected(what, res) {
  const said = serverSaid(res.body);
  return `${what} answered ${res.status}${said ? ` (${said})` : ''}.`;
}

/**
 * Run the live check. Never throws. Returns
 * { ok, stage, trackingEnabled, accepted, found, acceptedAt, event, note }
 * plus retried: ['GET /api/v1/settings', ...] when a step was tried twice
 * where ok means the event was read back, and stage is where it stopped:
 * settings, session, track, read_back or stored.
 */
export async function runLive({
  apiUrl,
  key,
  doctorVersion,
  intervalMs = DEFAULT_INTERVAL_MS,
  attempts = DEFAULT_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  request = apiRequest,
  sleep = sleepMs,
}) {
  const live = {
    ok: false,
    stage: 'settings',
    trackingEnabled: null,
    accepted: false,
    found: false,
    acceptedAt: null,
    event: PING_EVENT,
    note: '',
  };
  const keyHeader = { 'X-API-Key': key };
  const retried = [];
  // One request, tried a second time after retryDelayMs on a transient answer.
  // A batch retry may send the ping twice; harmless, as both carry the same nonce, are unmetered and stay out of analytics.
  const step = async (method, path, opts) => {
    const first = await request(apiUrl, method, path, opts);
    if (!transient(first)) return first;
    await sleep(retryDelayMs);
    retried.push({
      step: `${method} ${path}`,
      first: first.reached ? String(first.status) : first.error,
    });
    return request(apiUrl, method, path, opts);
  };
  // The live result with the retry note, when a step was retried.
  const done = (result) => {
    if (retried.length === 0) return result;
    const said = retried.map((r) => `${r.step} retried once after ${r.first}`).join('; ');
    return { ...result, retried: retried.map((r) => r.step), note: `${result.note} (${said}.)` };
  };

  const settings = await step('GET', '/api/v1/settings', { headers: keyHeader });
  if (!settings.reached) return done({ ...live, note: 'Live check failed: ' + unreachable(settings) });
  if (settings.status === 401) {
    return done({
      ...live,
      note:
        'Live check failed: the API rejected the ingest key (401). Check the --key value, ' +
        'RAVENSIGHT_INGEST_KEY, or the key in your project.',
    });
  }
  if (settings.status !== 200 || !settings.body || typeof settings.body.trackingEnabled !== 'boolean') {
    return done({ ...live, note: 'Live check failed: ' + unexpected('GET /api/v1/settings', settings) });
  }
  live.trackingEnabled = settings.body.trackingEnabled;
  if (!live.trackingEnabled) {
    return done({
      ...live,
      note:
        'Live check stopped: Tracking is switched off for this game, so the API accepts no ' +
        'events. Turn tracking on in the game settings on your Ravensight dashboard.',
    });
  }

  live.stage = 'session';
  const deviceId = 'doctor-' + crypto.randomBytes(4).toString('hex');
  const session = await step('POST', '/api/v1/session', {
    headers: keyHeader,
    body: { deviceId, platform: 'doctor', gameVersion: doctorVersion },
  });
  if (!session.reached) return done({ ...live, note: 'Live check failed: ' + unreachable(session) });
  if (session.status === 403 && serverSaid(session.body) === 'tracking_disabled') {
    return done({
      ...live,
      trackingEnabled: false,
      note: 'Live check stopped: Tracking is switched off for this game, so the API accepts no events.',
    });
  }
  if (session.status !== 201 || !session.body || typeof session.body.token !== 'string') {
    return done({ ...live, note: 'Live check failed: ' + unexpected('POST /api/v1/session', session) });
  }

  live.stage = 'track';
  const nonce = crypto.randomBytes(16).toString('hex');
  const batch = await step('POST', '/api/v1/track/batch', {
    headers: { 'X-Session-Token': session.body.token },
    body: { events: [{ event: PING_EVENT, data: { rs_kind: 'none', rs_doctor: nonce, doctorVersion } }] },
  });
  if (!batch.reached) return done({ ...live, note: 'Live check failed: ' + unreachable(batch) });
  if (batch.status !== 202 || !batch.body || !(batch.body.accepted >= 1)) {
    return done({ ...live, note: 'Live check failed: ' + unexpected('POST /api/v1/track/batch', batch) });
  }
  live.accepted = true;

  live.stage = 'read_back';
  let last = '';
  for (let i = 0; i < attempts; i++) {
    await sleep(intervalMs);
    const ping = await request(apiUrl, 'GET', `/api/v1/doctor/ping/${nonce}`, { headers: keyHeader });
    if (!ping.reached) {
      last = ping.error;
      continue;
    }
    if (ping.status === 200 && ping.body && ping.body.found === true) {
      return done({
        ...live,
        ok: true,
        stage: 'stored',
        found: true,
        acceptedAt: ping.body.acceptedAt ?? null,
        note: 'The ping event was accepted and stored.',
      });
    }
    if (ping.status === 400 || ping.status === 401) {
      last = `${ping.status}${serverSaid(ping.body) ? ' ' + serverSaid(ping.body) : ''}`;
      break;
    }
    last = String(ping.status);
  }
  const seconds = Math.round((intervalMs * attempts) / 1000);
  return done({
    ...live,
    note:
      `The ping event was accepted by the API, not read back within ${seconds} s` +
      (last && last !== '404' ? ` (last answer: ${last})` : '') +
      '. Events can take longer to land, or this server may not support the read back yet.',
  });
}
