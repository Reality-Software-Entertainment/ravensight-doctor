import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { run } from '../lib/cli.js';
import { makeProject, runCli, startServer } from './helpers.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const KEY = 'gt_live_' + 'Lv3_-Kk7'.repeat(4);
const FAST = { intervalMs: 5, attempts: 3, retryDelayMs: 5 };

function project(t) {
  return makeProject(t, {
    'project.godot': 'config_version=5\n',
    'addons/ravensight/Ravensight.gd': 'extends Node\n',
    'main.gd': `extends Node\nfunc _ready():\n\tRavensight.ingest_key = "${KEY}"\n\tRavensight.track("boot")\n`,
  });
}

function sink() {
  let text = '';
  return { write: (s) => ((text += s), true), get text() { return text; }, isTTY: false };
}

async function runIn(argv, live = FAST) {
  const stdout = sink();
  const stderr = sink();
  const code = await run(argv, { stdout, stderr, env: {}, live });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

/**
 * A fake Ravensight API. routes: { settings, session, batch, ping } each
 * (req, body, n) => [status, json]; ping n counts from 1. Records calls.
 */
async function fakeApi(routes) {
  const calls = [];
  const counts = {};
  const { server, url } = await startServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      let name = null;
      if (req.method === 'GET' && req.url === '/api/v1/settings') name = 'settings';
      else if (req.method === 'POST' && req.url === '/api/v1/session') name = 'session';
      else if (req.method === 'POST' && req.url === '/api/v1/track/batch') name = 'batch';
      else if (req.method === 'GET' && req.url.startsWith('/api/v1/doctor/ping/')) name = 'ping';
      else if (req.method === 'POST' && req.url === '/api/v1/doctor') name = 'report';
      calls.push({ name, method: req.method, url: req.url, headers: req.headers, body });
      counts[name] = (counts[name] || 0) + 1;
      const handler = routes[name];
      const [status, json] = handler ? handler(req, body, counts[name]) : [404, { error: 'not_found' }];
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  return { server, url, calls };
}

const OK_ROUTES = {
  settings: () => [200, { trackingEnabled: true }],
  session: () => [201, { token: 'tok_doctor', expiresAt: '2026-10-10T00:10:00Z', expiresIn: 600 }],
  batch: () => [202, { accepted: 1 }],
};

test('--live happy path: settings, session, one ping event, read back', async (t) => {
  const api = await fakeApi({
    ...OK_ROUTES,
    ping: (req, body, n) => (n < 2 ? [404, { found: false, error: 'ping_not_found' }] : [200, { found: true, acceptedAt: '2026-10-10T00:00:01.000Z' }]),
  });
  try {
    const { code, stdout, stderr } = await runIn([project(t), '--live', '--json', '--api-url', api.url]);
    assert.equal(code, 0);
    assert.ok(!stdout.includes(KEY) && !stderr.includes(KEY), 'the key is never printed');
    const rep = JSON.parse(stdout);
    assert.equal(rep.summary.status, 'pass');
    assert.ok(!rep.findings.some((f) => f.id.startsWith('live_')));
    assert.deepEqual(rep.live, {
      ok: true,
      stage: 'stored',
      trackingEnabled: true,
      accepted: true,
      found: true,
      acceptedAt: '2026-10-10T00:00:01.000Z',
      event: 'ravensight_doctor_ping',
      note: rep.live.note,
    });

    const settings = api.calls.find((c) => c.name === 'settings');
    assert.equal(settings.headers['x-api-key'], KEY);
    const session = api.calls.find((c) => c.name === 'session');
    assert.equal(session.headers['x-api-key'], KEY);
    assert.equal(session.body.platform, 'doctor');
    assert.match(session.body.deviceId, /^doctor-[0-9a-f]+$/);
    assert.equal(session.body.gameVersion, pkg.version);
    const batch = api.calls.find((c) => c.name === 'batch');
    assert.equal(batch.headers['x-session-token'], 'tok_doctor');
    assert.equal(batch.body.events.length, 1);
    const ev = batch.body.events[0];
    assert.equal(ev.event, 'ravensight_doctor_ping');
    assert.equal(ev.data.rs_kind, 'none');
    assert.match(ev.data.rs_doctor, /^[0-9a-f]{32}$/);
    assert.equal(ev.data.doctorVersion, pkg.version);
    const pings = api.calls.filter((c) => c.name === 'ping');
    assert.equal(pings.length, 2);
    for (const p of pings) {
      assert.equal(p.url, `/api/v1/doctor/ping/${ev.data.rs_doctor}`);
      assert.equal(p.headers['x-api-key'], KEY);
    }
    // the order is settings, session, batch, then the read back
    assert.deepEqual(api.calls.map((c) => c.name).slice(0, 3), ['settings', 'session', 'batch']);
  } finally {
    api.server.close();
  }
});

test('--live failure: a rejected key stops at settings and exits 1', async (t) => {
  const api = await fakeApi({ ...OK_ROUTES, settings: () => [401, { error: 'invalid_api_key' }] });
  try {
    const { code, stdout } = await runIn([project(t), '--live', '--json', '--api-url', api.url]);
    assert.equal(code, 1);
    const { live } = JSON.parse(stdout);
    assert.equal(live.ok, false);
    assert.equal(live.stage, 'settings');
    assert.equal(live.accepted, false);
    assert.match(live.note, /401/);
    const rep = JSON.parse(stdout);
    assert.equal(rep.summary.status, 'fail');
    assert.ok(rep.findings.some((f) => f.id === 'live_check_failed' && f.severity === 'error'));
    assert.deepEqual(api.calls.map((c) => c.name), ['settings']);
  } finally {
    api.server.close();
  }
});

test('--live failure: tracking switched off stops before a session is made', async (t) => {
  const api = await fakeApi({ ...OK_ROUTES, settings: () => [200, { trackingEnabled: false }] });
  try {
    const { code, stdout } = await runIn([project(t), '--live', '--api-url', api.url]);
    assert.equal(code, 1);
    assert.match(stdout, /Live check/);
    assert.match(stdout, /Tracking is switched off/);
    assert.match(stdout, /live_check_failed/);
    assert.match(stdout, /Status: {2}fail/);
    assert.deepEqual(api.calls.map((c) => c.name), ['settings']);
  } finally {
    api.server.close();
  }
});

test('--live failure: never read back (a server without the read back) warns, exit 0, 1 with --strict', async (t) => {
  // No ping route: every read back is a plain 404, like a server that predates it.
  const api = await fakeApi(OK_ROUTES);
  try {
    const dir = project(t);
    const plain = await runIn([dir, '--live', '--json', '--api-url', api.url]);
    assert.equal(plain.code, 0);
    const rep = JSON.parse(plain.stdout);
    assert.equal(rep.live.ok, false);
    assert.equal(rep.live.stage, 'read_back');
    assert.equal(rep.live.accepted, true);
    assert.equal(rep.live.found, false);
    assert.match(rep.live.note, /accepted by the API, not read back within/);
    assert.ok(rep.findings.some((f) => f.id === 'live_ping_unconfirmed' && f.severity === 'warning'));
    assert.equal(rep.summary.status, 'warn');
    assert.equal(api.calls.filter((c) => c.name === 'ping').length, FAST.attempts);

    const strict = await runIn([dir, '--live', '--strict', '--api-url', api.url]);
    assert.equal(strict.code, 1);
  } finally {
    api.server.close();
  }
});

test('--live failure: an unreachable API is a live_check_failed error, exit 1', async (t) => {
  const { code, stdout } = await runIn([project(t), '--live', '--api-url', 'http://127.0.0.1:9']);
  assert.equal(code, 1);
  assert.match(stdout, /live_check_failed/);
  assert.match(stdout, /Status: {2}fail/);
  assert.match(stdout, /could not reach/);
});

test('--live failure: a refused session or event is a live_check_failed error', async (t) => {
  for (const [route, answer, stage] of [
    ['session', [403, { error: 'tracking_disabled' }], 'session'],
    ['session', [500, { error: 'internal_error' }], 'session'],
    ['batch', [400, { error: 'doctor_event_only' }], 'track'],
  ]) {
    const api = await fakeApi({ ...OK_ROUTES, [route]: () => answer });
    try {
      const { code, stdout } = await runIn([project(t), '--live', '--json', '--api-url', api.url]);
      assert.equal(code, 1);
      const rep = JSON.parse(stdout);
      assert.equal(rep.live.stage, stage);
      assert.equal(rep.summary.status, 'fail');
      assert.equal(rep.findings.filter((f) => f.id === 'live_check_failed').length, 1);
    } finally {
      api.server.close();
    }
  }
});

test('--live failure then --report: the submitted report says fail', async (t) => {
  const api = await fakeApi({ ...OK_ROUTES, settings: () => [401, { error: 'invalid_api_key' }], report: () => [201, {}] });
  try {
    const { code } = await runIn([project(t), '--live', '--report', '--api-url', api.url]);
    assert.equal(code, 1);
    const report = api.calls.find((c) => c.name === 'report').body;
    assert.equal(report.summary.status, 'fail');
    assert.ok(report.findings.some((f) => f.id === 'live_check_failed'));
  } finally {
    api.server.close();
  }
});

test('a live finding on a scan already at 100 findings keeps the truncation marker honest', async (t) => {
  let planted = '';
  for (let i = 0; i < 100; i++) planted += `t${i} = "gt_mcp_FAKEFAKE${String(i).padStart(8, '0')}"\n`;
  const dir = makeProject(t, {
    'project.godot': 'config_version=5\n',
    'addons/ravensight/Ravensight.gd': 'extends Node\n',
    'main.gd': `extends Node\nfunc _ready():\n\tRavensight.ingest_key = "${KEY}"\n\tRavensight.track("boot")\n`,
    'secrets.txt': planted,
  });
  const api = await fakeApi(OK_ROUTES); // accepted, never read back
  try {
    const { stdout } = await runIn([dir, '--live', '--json', '--api-url', api.url]);
    const rep = JSON.parse(stdout);
    assert.equal(rep.findings.length, 100);
    const last = rep.findings[99];
    assert.equal(last.id, 'findings_truncated');
    assert.match(last.detail, /^101 findings were produced/);
    assert.equal(rep.summary.errors, 100);
    assert.equal(rep.summary.warnings, 1);
  } finally {
    api.server.close();
  }
});

test('--live refuses a key that only exists under test paths', async (t) => {
  const dir = makeProject(t, {
    'project.godot': 'config_version=5\n',
    'addons/ravensight/Ravensight.gd': 'extends Node\n',
    'main.gd': 'extends Node\nfunc _ready():\n\tRavensight.track("boot")\n',
    'tests/k.gd': `var k = "${KEY}"\n`,
  });
  const { code, stdout } = await runIn([dir, '--live', '--json', '--api-url', 'http://127.0.0.1:9']);
  assert.equal(code, 1);
  const { live, findings } = JSON.parse(stdout);
  assert.ok(findings.some((f) => f.id === 'live_check_failed'));
  assert.equal(live.stage, 'key');
  assert.match(live.note, /test paths/);
});

test('--live then --report: the report is sent after the live check, as the API expects it', async (t) => {
  const api = await fakeApi({
    ...OK_ROUTES,
    ping: () => [200, { found: true, acceptedAt: '2026-10-10T00:00:01.000Z' }],
    report: () => [201, { stored: true }],
  });
  try {
    const { code } = await runIn([project(t), '--live', '--report', '--api-url', api.url]);
    assert.equal(code, 0);
    const names = api.calls.map((c) => c.name);
    assert.equal(names[names.length - 1], 'report');
    const report = api.calls.find((c) => c.name === 'report').body;
    assert.ok(!('live' in report));
    assert.ok(!('inventory' in report));
  } finally {
    api.server.close();
  }
});

test('--live through the real binary reads back the ping', async (t) => {
  const api = await fakeApi({ ...OK_ROUTES, ping: () => [200, { found: true, acceptedAt: '2026-10-10T00:00:02.000Z' }] });
  try {
    const { code, stdout } = await runCli([project(t), '--live', '--api-url', api.url]);
    assert.equal(code, 0);
    assert.match(stdout, /Live check/);
    assert.match(stdout, /stored/);
    assert.ok(!stdout.includes(KEY));
  } finally {
    api.server.close();
  }
});

test('--help lists every option', async () => {
  const { code, stdout } = await runCli(['--help']);
  assert.equal(code, 0);
  for (const flag of ['--json', '--report', '--live', '--strict', '--track-fn', '--ignore', '--no-gitignore', '--key', '--api-url', '--version']) {
    assert.ok(stdout.includes(flag), flag);
  }
  assert.ok(!/[–—]/.test(stdout), 'no en or em dashes');
});

// 0.3.1: one retry on a transient answer

test('--live retries a 502 once per step and passes with the note', async (t) => {
  for (const route of ['settings', 'session', 'batch']) {
    const api = await fakeApi({
      ...OK_ROUTES,
      [route]: (req, body, n) => (n === 1 ? [502, { error: 'bad_gateway' }] : OK_ROUTES[route]()),
      ping: () => [200, { found: true, acceptedAt: '2026-10-10T00:00:01.000Z' }],
    });
    try {
      const { code, stdout } = await runIn([project(t), '--live', '--json', '--api-url', api.url]);
      assert.equal(code, 0, route);
      const rep = JSON.parse(stdout);
      assert.equal(rep.live.ok, true);
      assert.equal(rep.live.retried.length, 1);
      assert.match(rep.live.note, /retried once after 502/);
      assert.equal(api.calls.filter((c) => c.name === route).length, 2);
    } finally {
      api.server.close();
    }
  }
});

test('--live says retried once in the pretty report', async (t) => {
  const api = await fakeApi({
    ...OK_ROUTES,
    settings: (req, body, n) => (n === 1 ? [502, {}] : [200, { trackingEnabled: true }]),
    ping: () => [200, { found: true }],
  });
  try {
    const { code, stdout } = await runIn([project(t), '--live', '--api-url', api.url]);
    assert.equal(code, 0);
    assert.match(stdout, /GET \/api\/v1\/settings retried once after 502/);
    assert.ok(!/[–—]/.test(stdout));
  } finally {
    api.server.close();
  }
});

test('--live fails on a second 502', async (t) => {
  const api = await fakeApi({ ...OK_ROUTES, settings: () => [502, { error: 'bad_gateway' }] });
  try {
    const { code, stdout } = await runIn([project(t), '--live', '--json', '--api-url', api.url]);
    assert.equal(code, 1);
    const rep = JSON.parse(stdout);
    assert.equal(rep.live.stage, 'settings');
    assert.deepEqual(rep.live.retried, ['GET /api/v1/settings']);
    assert.match(rep.live.note, /answered 502/);
    assert.ok(rep.findings.some((f) => f.id === 'live_check_failed'));
    assert.deepEqual(api.calls.map((c) => c.name), ['settings', 'settings']);
  } finally {
    api.server.close();
  }
});

test('--live never retries a 4xx', async (t) => {
  const api = await fakeApi({ ...OK_ROUTES, settings: () => [401, { error: 'invalid_api_key' }] });
  try {
    const { code, stdout } = await runIn([project(t), '--live', '--json', '--api-url', api.url]);
    assert.equal(code, 1);
    const rep = JSON.parse(stdout);
    assert.ok(!('retried' in rep.live));
    assert.deepEqual(api.calls.map((c) => c.name), ['settings']);
  } finally {
    api.server.close();
  }
});

test('--live retries a network error once and waits between tries', async () => {
  const waits = [];
  const answers = [{ reached: false, error: 'ECONNRESET', url: 'x' }, { reached: true, status: 200, body: { trackingEnabled: false }, url: 'x' }];
  const { runLive } = await import('../lib/live.js');
  const live = await runLive({
    apiUrl: 'http://example.invalid',
    key: KEY,
    doctorVersion: '0.0.0',
    request: async () => answers.shift(),
    sleep: async (ms) => waits.push(ms),
  });
  assert.deepEqual(waits, [3000]);
  assert.equal(live.trackingEnabled, false);
  assert.match(live.note, /retried once after ECONNRESET/);
});
