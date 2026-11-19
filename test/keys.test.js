import test from 'node:test';
import assert from 'node:assert/strict';
import { scanProject, resolveKey } from '../lib/cli.js';
import { isTestPath } from '../lib/checks.js';
import { makeProject, byId, ids, runCli, startServer } from './helpers.js';

const BODY = 'Ab3_-xY9'.repeat(4); // 32 chars of [A-Za-z0-9_-], fake
const KEY = 'gt_live_' + BODY;
const GD_SDK = {
  'project.godot': 'config_version=5\n',
  'addons/ravensight/Ravensight.gd': 'extends Node\nfunc track(n, d := {}):\n\treturn true\n',
  'main.gd': 'extends Node\nfunc go():\n\tRavensight.track("boot")\n',
};

test('the ingest key regex is exactly 32 characters of [A-Za-z0-9_-]', (t) => {
  const dir = makeProject(t, {
    ...GD_SDK,
    'a.gd': `var k = "${KEY}"\n`,
    'b.txt': `short gt_live_${BODY.slice(1)}\nlong gt_live_${BODY}X\nbroken gt_live_${BODY.slice(0, 20)}!${BODY.slice(20)}\n`,
  });
  const scan = scanProject(dir);
  assert.deepEqual(scan.liveKeys, [KEY]);
  assert.ok(!ids(scan.findings).includes('no_ingest_key'));
});

test('isTestPath: test directories and *.test.* / *.spec.* files', () => {
  for (const p of [
    'test/a.js',
    'tests/a.gd',
    'src/__tests__/a.js',
    'src/__fixtures__/k.json',
    'src/__mocks__/rs.js',
    'spec/fixtures/game/a.gd',
    'src/game.test.js',
    'src/game.spec.ts',
    'Game.Tests/x.test.cs',
  ]) {
    assert.equal(isTestPath(p), true, p);
  }
  for (const p of ['src/game.js', 'testing/a.js', 'contest/a.gd', 'src/latest.js', 'attest.js', 'src/testdata.js']) {
    assert.equal(isTestPath(p), false, p);
  }
});

test('keys under test paths never satisfy no_ingest_key', (t) => {
  const dir = makeProject(t, {
    ...GD_SDK,
    'test/fixtures/setup.gd': `var k = "${KEY}"\n`,
    'src/net.spec.js': `const k = "gt_live_${'Q'.repeat(32)}";\n`,
  });
  const scan = scanProject(dir);
  assert.equal(scan.liveKeys.length, 0);
  assert.equal(scan.testKeys.length, 2);
  const missing = byId(scan.findings, 'no_ingest_key');
  assert.equal(missing.length, 1);
  assert.match(missing[0].detail, /test paths/);
  assert.deepEqual(scan.inventory.ingestKeys, { live: 0, test: 2 });
});

test('a test-path key does not trigger clause B', (t) => {
  const dir = makeProject(t, {
    'project.godot': 'config_version=5\n',
    'addons/ravensight/Ravensight.gd': 'extends Node\n',
    'tests/k.gd': `var k = "${KEY}"\n`,
  });
  const scan = scanProject(dir);
  assert.ok(!ids(scan.findings).includes('tracking_unverified'));
  assert.ok(ids(scan.findings).includes('no_track_calls'));
});

test('resolveKey: flag, then env, then the first project key; test keys never', () => {
  const scan = { liveKeys: ['gt_live_P'], testKeys: ['gt_live_T'] };
  assert.deepEqual(resolveKey({ flag: 'gt_live_F', env: 'gt_live_E', scan }), { key: 'gt_live_F', source: 'flag', testOnly: false });
  assert.deepEqual(resolveKey({ env: 'gt_live_E', scan }), { key: 'gt_live_E', source: 'env', testOnly: false });
  assert.deepEqual(resolveKey({ scan }), { key: 'gt_live_P', source: 'project', testOnly: false });
  assert.deepEqual(resolveKey({ scan: { liveKeys: [], testKeys: ['gt_live_T'] } }), { key: null, source: null, testOnly: true });
  assert.deepEqual(resolveKey({ scan: { liveKeys: [], testKeys: [] } }), { key: null, source: null, testOnly: false });
});

test('--report refuses a key that only exists under test paths', async (t) => {
  let hits = 0;
  const { server, url } = await startServer((req, res) => {
    hits++;
    req.resume();
    req.on('end', () => {
      res.writeHead(201);
      res.end();
    });
  });
  try {
    const dir = makeProject(t, { ...GD_SDK, 'test/fixtures/setup.gd': `var k = "${KEY}"\n` });
    const { code, stderr, stdout } = await runCli([dir, '--report', '--api-url', url]);
    assert.equal(code, 1);
    assert.match(stderr, /only gt_live_ keys found are under test paths/);
    assert.equal(hits, 0);
    assert.ok(!(stdout + stderr).includes(KEY));
  } finally {
    server.close();
  }
});

// Studio credentials other than the MCP token: a CLI token, a desktop app
// key and the MCP OAuth pair. None belongs in a game build.
test('wrong_key_type flags every studio credential, masked', (t) => {
  const secret = 'Zq9_-Lm2'.repeat(5) + 'abc'; // 43 chars, fake
  const dir = makeProject(t, {
    ...GD_SDK,
    'config/creds.cfg': [
      `cli = "gt_cli_${secret}"`,
      `desktop = "gt_raven_${secret}"`,
      `oauth = "gt_oauth_${secret}"`,
      `refresh = "gt_refresh_${secret}"`,
      'prose = "a gt_cli_ token is made in Settings"',
    ].join('\n') + '\n',
  });
  const scan = scanProject(dir);
  const wrong = byId(scan.findings, 'wrong_key_type');
  assert.deepEqual(wrong.map((f) => f.line), [1, 2, 3, 4]);
  const details = wrong.map((f) => f.detail).join('\n');
  for (const kind of ['CLI token', 'desktop app key', 'MCP sign-in token', 'MCP sign-in refresh token']) {
    assert.ok(details.includes(kind), kind);
  }
  assert.ok(!JSON.stringify(scan.findings).includes(secret));
});

// A website key is publishable, so it is not a secret, but it cannot send
// gameplay events: say so when it is the only key in the tree.
test('no_ingest_key names a gt_site_ website key found instead of a game key', (t) => {
  const site = 'gt_site_' + 'Wq3-Rt7_'.repeat(4);
  const dir = makeProject(t, { ...GD_SDK, 'web/site.js': `createSiteTracker({ key: '${site}' })\n` });
  const scan = scanProject(dir);
  const [missing] = byId(scan.findings, 'no_ingest_key');
  assert.ok(missing, 'no_ingest_key still raised');
  assert.match(missing.detail, /gt_site_ website key/);
  assert.match(missing.detail, /cannot send gameplay events/);
  assert.ok(!missing.detail.includes(site));
  assert.equal(byId(scan.findings, 'wrong_key_type').length, 0);
});

test('a gt_site_ key beside a gt_live_ key adds nothing', (t) => {
  const site = 'gt_site_' + 'Wq3-Rt7_'.repeat(4);
  const dir = makeProject(t, { ...GD_SDK, 'a.gd': `var k = "${KEY}"\n`, 'web/site.js': `const s = '${site}'\n` });
  const scan = scanProject(dir);
  assert.equal(byId(scan.findings, 'no_ingest_key').length, 0);
  assert.equal(byId(scan.findings, 'wrong_key_type').length, 0);
});
