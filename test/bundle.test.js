// 0.4.2: ingestKey.source and --bundle.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scanProject, resolveKey } from '../lib/cli.js';
import { checkBundle, rawBinaryStrings, BundleError } from '../lib/bundle.js';
import { loadConfig, ConfigError } from '../lib/config.js';
import { makeProject, byId, runCli, fixture } from './helpers.js';

const BUNDLES = fixture('bundles');
const FIXTURE_KEY = 'gt_live_FixtureBundleKey0123456789abcdef';

function swiftProject(t, config) {
  return makeProject(t, {
    'Package.swift': '// dependencies: ravensight-swift\n',
    'Sources/Game/Boot.swift': 'import Ravensight\nfunc boot() {\n    Ravensight.track("game_opened")\n}\n',
    ...(config ? { 'ravensight.config.json': JSON.stringify(config) } : {}),
  });
}

test('ingestKey source build and env turn no_ingest_key into an info; the default stays a warning', (t) => {
  const plain = byId(scanProject(swiftProject(t)).allFindings, 'no_ingest_key');
  assert.equal(plain[0].severity, 'warning');
  assert.match(plain[0].detail, /ingestKey\.source/);
  const build = byId(scanProject(swiftProject(t, { ingestKey: { source: 'build' } })).allFindings, 'no_ingest_key');
  assert.equal(build[0].severity, 'info');
  assert.equal(build[0].title, 'Key is injected at build time; check the built bundle');
  assert.match(build[0].detail, /--bundle/);
  const env = byId(scanProject(swiftProject(t, { ingestKey: { source: 'env' } })).allFindings, 'no_ingest_key');
  assert.equal(env[0].severity, 'info');
  assert.match(env[0].title, /environment at startup/);
  const scan = scanProject(swiftProject(t, { ingestKey: { source: 'env' } }));
  assert.equal(scan.totals.warnings, 0);
});

test('ingestKey is validated', (t) => {
  for (const bad of ['"build"', '{}', '{"source": "xcconfig"}', '[]']) {
    const dir = makeProject(t, { 'ravensight.config.json': `{"ingestKey": ${bad}}` });
    assert.throws(() => loadConfig(dir), ConfigError, bad);
  }
});

test('--bundle on a built .app, a macOS .app and a binary plist reports bundle_key_present', (t) => {
  for (const p of ['Game.app', 'Mac.app', 'Binary.app', 'Game.app/Info.plist']) {
    const r = checkBundle(path.join(BUNDLES, p));
    assert.equal(r.keyPresent, true, p);
    assert.equal(r.finding.id, 'bundle_key_present');
    assert.equal(r.finding.severity, 'info');
    assert.ok(!JSON.stringify(r).includes(FIXTURE_KEY), 'the key is never in the result');
    assert.ok(!r.finding.detail.includes('FixtureBundleKey'));
  }
});

test('a binary plist is read without plutil too', () => {
  const r = checkBundle(path.join(BUNDLES, 'Binary.app'), { convert: () => null });
  assert.equal(r.format, 'binary-raw');
  assert.equal(r.keyPresent, true);
  const longer = Buffer.concat([Buffer.from([0x5f, 0x10, 41]), Buffer.from(FIXTURE_KEY + 'x', 'latin1')]);
  assert.equal(rawBinaryStrings(longer), '');
});

test('the source Info.plist with unexpanded settings is bundle_key_missing with the hint', () => {
  const r = checkBundle(path.join(BUNDLES, 'Info-source.plist'));
  assert.equal(r.keyPresent, false);
  assert.equal(r.finding.id, 'bundle_key_missing');
  assert.equal(r.finding.severity, 'warning');
  assert.match(r.finding.detail, /unexpanded \$\(\.\.\.\) build settings/);
});

test('a path with no Info.plist is a BundleError, exit 2 on the CLI', async (t) => {
  assert.throws(() => checkBundle(path.join(BUNDLES, 'nope.app')), BundleError);
  const dir = swiftProject(t);
  assert.throws(() => checkBundle(dir), /no Info\.plist/);
  const { code, stderr } = await runCli([dir, '--bundle', dir]);
  assert.equal(code, 2);
  assert.match(stderr, /no Info\.plist/);
});

test('the CLI: --bundle replaces no_ingest_key, prints nothing of the key, and feeds --live', async (t) => {
  const dir = swiftProject(t, { ingestKey: { source: 'build' } });
  const { code, stdout, stderr } = await runCli([dir, '--json', '--bundle', path.join(BUNDLES, 'Game.app')]);
  assert.equal(code, 0);
  assert.ok(!stdout.includes('FixtureBundleKey') && !stderr.includes('FixtureBundleKey'));
  const rep = JSON.parse(stdout);
  assert.deepEqual(rep.findings.map((f) => f.id), ['bundle_key_present']);
  assert.equal(rep.bundle.keyPresent, true);
  assert.equal(rep.summary.status, 'pass');
  const scan = scanProject(dir, { bundle: path.join(BUNDLES, 'Game.app') });
  assert.deepEqual(resolveKey({ scan }), { key: FIXTURE_KEY, source: 'bundle', testOnly: false });

  const missing = await runCli([dir, '--json', '--bundle', path.join(BUNDLES, 'Info-source.plist')]);
  const rep2 = JSON.parse(missing.stdout);
  assert.deepEqual(rep2.findings.map((f) => f.id).sort(), ['bundle_key_missing', 'no_ingest_key']);
  assert.equal(rep2.summary.status, 'warn');
});

test('the fixture key is a well formed ingest key', () => {
  assert.match(fs.readFileSync(path.join(BUNDLES, 'Game.app/Info.plist'), 'utf8'), /gt_live_[A-Za-z0-9_-]{32}</);
});
