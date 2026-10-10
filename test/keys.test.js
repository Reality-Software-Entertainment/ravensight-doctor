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
