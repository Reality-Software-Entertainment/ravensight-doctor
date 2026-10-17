// 0.4.2: ingestKey.source and --bundle. 0.5.0: live_key_in_bundle.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { scanProject, resolveKey } from '../lib/cli.js';
import { checkBundle, rawBinaryStrings, BundleError, keyHint, zipEntries, redactKeys } from '../lib/bundle.js';
import { loadConfig, ConfigError } from '../lib/config.js';
import { makeProject, byId, runCli, fixture, startServer } from './helpers.js';

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

test('--bundle on a built .app, a macOS .app and a binary plist reports bundle_key_present beside the live key error', (t) => {
  for (const p of ['Game.app', 'Mac.app', 'Binary.app', 'Game.app/Info.plist']) {
    const r = checkBundle(path.join(BUNDLES, p));
    assert.equal(r.keyPresent, true, p);
    assert.equal(r.finding.id, 'bundle_key_present');
    assert.equal(r.finding.severity, 'info');
    assert.deepEqual(r.findings.map((f) => f.id), ['live_key_in_bundle', 'bundle_key_present'], p);
    assert.equal(r.keys.live, 1);
    assert.ok(!JSON.stringify(r).includes(FIXTURE_KEY), 'the key is never in the result');
    assert.ok(!JSON.stringify(r).includes('FixtureBundleKey'), 'nothing past eight characters of the key');
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

test('a missing path or an empty directory is a BundleError, exit 2 on the CLI', async (t) => {
  assert.throws(() => checkBundle(path.join(BUNDLES, 'nope.app')), BundleError);
  const empty = makeProject(t, {});
  assert.throws(() => checkBundle(empty), /has no files/);
  const dir = swiftProject(t);
  const { code, stderr } = await runCli([dir, '--bundle', path.join(BUNDLES, 'nope.app')]);
  assert.equal(code, 2);
  assert.match(stderr, /does not exist/);
});

test('the CLI: a gt_live_ key in --bundle is a warning (exit 1 only with --strict), prints only its hint, and feeds --live', async (t) => {
  const dir = swiftProject(t, { ingestKey: { source: 'build' } });
  for (const [extra, want] of [[[], 0], [['--strict'], 1]]) {
    const { code, stdout, stderr } = await runCli([dir, '--json', ...extra, '--bundle', path.join(BUNDLES, 'Game.app')]);
    assert.equal(code, want, extra.join(' '));
    assert.ok(!stdout.includes('FixtureBundleKey') && !stderr.includes('FixtureBundleKey'));
    const rep = JSON.parse(stdout);
    assert.deepEqual(rep.findings.map((f) => f.id), ['live_key_in_bundle', 'bundle_key_present']);
    assert.equal(rep.findings[0].severity, 'warning');
    assert.match(rep.findings[0].detail, /gt_live_FixtureB\.\.\./);
    assert.match(rep.findings[0].detail, /https:\/\/ravensight\.io\/docs\/#public-builds/);
    assert.equal(rep.bundle.keyPresent, true);
    assert.deepEqual(rep.bundle.keys, { live: 1, public: 0 });
    assert.equal(rep.summary.status, 'warn');
  }
  const pretty = await runCli([dir, '--bundle', path.join(BUNDLES, 'Game.app')]);
  assert.ok(!pretty.stdout.includes('FixtureBundleKey'));
  assert.match(pretty.stdout, /live_key_in_bundle|gt_live_ key ships/);
  const scan = scanProject(dir, { bundle: path.join(BUNDLES, 'Game.app') });
  assert.deepEqual(resolveKey({ scan }), { key: FIXTURE_KEY, source: 'bundle', testOnly: false });

  const missing = await runCli([dir, '--json', '--bundle', path.join(BUNDLES, 'Info-source.plist')]);
  const rep2 = JSON.parse(missing.stdout);
  assert.deepEqual(rep2.findings.map((f) => f.id).sort(), ['bundle_key_missing', 'no_ingest_key']);
  assert.equal(rep2.summary.status, 'warn');
});

// Keys built at run time so no whole key sits in the test source.
const SECRET = 'Zq9xK2mWv7Lp4Rt8Yb3Nc6Hd1Fg5Js0A';
const LIVE = 'gt_live_' + SECRET;
const PUB = 'gt_pub_' + SECRET.split('').reverse().join('');

/** A zip of { name: Buffer | string } members, deflated unless the name ends with .stored. */
function zip(members, { prefix = Buffer.alloc(0), encrypted = [] } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(members)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const stored = name.endsWith('.stored');
    const body = stored ? data : zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    if (encrypted.includes(name)) central.writeUInt16LE(1, 8);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(members).length, 8);
  eocd.writeUInt16LE(Object.keys(members).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([prefix, ...locals, cd, eocd]);
}

function only(r, id) {
  return r.findings.filter((f) => f.id === id);
}

test('keyHint prints the kind prefix and eight characters only, as the dashboard does', () => {
  assert.equal(keyHint(LIVE), 'gt_live_Zq9xK2mW...');
  assert.equal(keyHint(PUB), 'gt_pub_A0sJ5gF1...');
});

test('a minified web build with a gt_live_ key is live_key_in_bundle, naming the file', (t) => {
  const dir = makeProject(t, {
    'index.html': '<!doctype html><script src="assets/index-3f9a.js"></script>',
    'assets/index-3f9a.js': `!function(){var e={k:"${LIVE}",u:"https://api.ravensight.io"};window.rs=e}();`,
  });
  const r = checkBundle(dir);
  assert.equal(r.format, 'directory');
  assert.equal(r.filesScanned, 2);
  const [f] = only(r, 'live_key_in_bundle');
  assert.equal(f.severity, 'warning');
  assert.match(f.file, /assets\/index-3f9a\.js$/);
  assert.match(f.detail, /gt_live_Zq9xK2mW\.\.\./);
  assert.match(f.detail, /public key \(gt_pub_\)/);
  assert.match(f.detail, /https:\/\/ravensight\.io\/docs\/#public-builds/);
  assert.ok(!JSON.stringify(r).includes(SECRET), 'the secret part never appears');
  assert.equal(r.key, LIVE, 'the key is kept for --live, not enumerable');
  assert.ok(!Object.keys(r).includes('key'));
  // A single minified file works the same way.
  const one = checkBundle(path.join(dir, 'assets/index-3f9a.js'));
  assert.equal(one.format, 'file');
  assert.equal(only(one, 'live_key_in_bundle').length, 1);
});

test('a gt_pub_ key in a bundle is bundle_key_present and nothing else', (t) => {
  const dir = makeProject(t, { 'game.js': `const KEY="${PUB}";` });
  const r = checkBundle(dir);
  assert.deepEqual(r.findings.map((f) => f.id), ['bundle_key_present']);
  assert.equal(r.keyPresent, true);
  assert.deepEqual(r.keys, { live: 0, public: 1 });
  assert.match(r.finding.detail, /gt_pub_ public key/);
  assert.equal(r.key, null, 'a public key is never offered to --live');
});

test('a gt_test_ shaped string is not a key kind and is not reported', (t) => {
  const dir = makeProject(t, { 'game.js': `const KEY="gt_test_${SECRET}";` });
  const r = checkBundle(dir);
  assert.deepEqual(r.findings.map((f) => f.id), ['bundle_key_missing']);
});

test('a .love zip member, deflated or stored, is found and named inside the archive', (t) => {
  const love = zip({
    'conf.lua': 'function love.conf(t) t.identity = "game" end\n',
    'lib/ravensight.lua': `return { key = "${LIVE}" }\n`,
    'data/keys.txt.stored': `public=${PUB}\n`,
  });
  const dir = makeProject(t, { 'Game.love': love });
  const r = checkBundle(path.join(dir, 'Game.love'));
  assert.equal(r.format, 'archive');
  const [live] = only(r, 'live_key_in_bundle');
  assert.match(live.file, /Game\.love!\/lib\/ravensight\.lua$/);
  assert.equal(r.keys.public, 1, 'the stored member was read');
  assert.ok(!JSON.stringify(r).includes(SECRET));
});

test('a fused executable with a .love appended, and a .love inside a release zip, are read', (t) => {
  const love = zip({ 'main.lua': `local k = "${LIVE}"\n` });
  const runtime = Buffer.concat([Buffer.from([0x4d, 0x5a, 0, 0]), Buffer.alloc(4096, 0x90)]);
  const fused = Buffer.concat([runtime, love]);
  assert.ok(zipEntries({ size: fused.length, read: (o, l) => fused.subarray(o, o + l) }));
  const release = zip({ 'Game-1.0/Game.love': love });
  const dir = makeProject(t, { 'Game.exe': fused, 'Game-1.0.zip': release });
  const exe = checkBundle(path.join(dir, 'Game.exe'));
  assert.match(only(exe, 'live_key_in_bundle')[0].file, /Game\.exe!\/main\.lua$/);
  const nested = checkBundle(path.join(dir, 'Game-1.0.zip'));
  assert.match(only(nested, 'live_key_in_bundle')[0].file, /Game-1\.0\.zip!\/Game-1\.0\/Game\.love!\/main\.lua$/);
});

test('a binary with the key as an ASCII string is found even with no separator after it', (t) => {
  const bin = Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]),
    Buffer.alloc(2048, 0),
    // A string table runs literals together: the key is followed by another literal.
    Buffer.from(`${LIVE}https://api.ravensight.io/api/v1`, 'latin1'),
    Buffer.alloc(64, 0),
  ]);
  const dir = makeProject(t, { 'Game.app/Contents/MacOS/Game': bin, 'Game.app/Contents/Info.plist': '<plist><dict/></plist>' });
  const r = checkBundle(path.join(dir, 'Game.app'));
  assert.equal(r.format, 'xml', 'the .app keeps its plist format');
  const [f] = only(r, 'live_key_in_bundle');
  assert.match(f.file, /Contents\/MacOS\/Game$/);
  // The plist answers presence, as before 0.5.0: a key elsewhere does not.
  assert.equal(r.keyPresent, false);
  assert.equal(r.finding.id, 'bundle_key_missing');
  assert.match(r.finding.detail, /Other files of the build carry a key/);
  assert.equal(r.key, null);
});

test('a key across the boundary of two read chunks is still found once', (t) => {
  const size = 8 * 1024 * 1024;
  const buf = Buffer.alloc(size + 1024, 0x20);
  buf.write(LIVE, size - 10, 'latin1');
  const dir = makeProject(t, { 'big.js': buf });
  const r = checkBundle(path.join(dir, 'big.js'));
  assert.equal(only(r, 'live_key_in_bundle').length, 1);
  assert.equal(r.keys.live, 1);
});

test('text keeps the source boundary: a longer token is not a key', (t) => {
  const dir = makeProject(t, { 'a.js': `x="${LIVE}extra";` });
  const r = checkBundle(dir);
  assert.deepEqual(r.findings.map((f) => f.id), ['bundle_key_missing']);
});

test('the CLI never prints a whole key from a bundle, pretty or JSON', async (t) => {
  const project = swiftProject(t, { ingestKey: { source: 'build' } });
  const build = makeProject(t, {
    'web/index.js': `var a="${LIVE}",c="${PUB}";`,
    'Game.love': zip({ 'main.lua': `k="${LIVE}"` }),
  });
  for (const extra of [['--json'], []]) {
    const { code, stdout, stderr } = await runCli([project, ...extra, '--bundle', build]);
    assert.equal(code, 0);
    for (const k of [SECRET, PUB.slice(7)]) {
      assert.ok(!stdout.includes(k) && !stderr.includes(k), 'no secret part is printed');
    }
    for (const k of [LIVE, PUB]) assert.ok(!stdout.includes(k.slice(0, k.indexOf('_', 3) + 10)), 'at most eight characters');
  }
  for (const extra of [['--json'], []]) {
    const { code } = await runCli([project, ...extra, '--strict', '--bundle', build]);
    assert.equal(code, 1, 'a live key fails under --strict');
  }
  const ok = makeProject(t, { 'web/index.js': `var c="${PUB}";` });
  const pass = await runCli([project, '--json', '--strict', '--bundle', ok]);
  assert.equal(pass.code, 0);
  assert.deepEqual(JSON.parse(pass.stdout).findings.map((f) => f.id), ['bundle_key_present']);
});

test('the fixture key is a well formed ingest key', () => {
  assert.match(fs.readFileSync(path.join(BUNDLES, 'Game.app/Info.plist'), 'utf8'), /gt_live_[A-Za-z0-9_-]{32}</);
});

// Security review of c9d4110..c4f9096: the old Info.plist guarantees, and no
// output path carrying more than the prefix and eight characters of a key.

test('regression: an .app answers presence from its Info.plist only, and --live falls back to that key only', async (t) => {
  const project = swiftProject(t, { ingestKey: { source: 'build' } });
  const app = makeProject(t, {
    'Game.app/Info.plist': '<plist><dict><key>CFBundleIdentifier</key><string>io.example.game</string></dict></plist>',
    'Game.app/Game': Buffer.concat([Buffer.alloc(16, 0), Buffer.from(LIVE, 'latin1'), Buffer.alloc(16, 0)]),
    'Game.app/config.js': `k="${PUB}"`,
  });
  const appPath = path.join(app, 'Game.app');
  const { code, stdout } = await runCli([project, '--json', '--bundle', appPath]);
  const rep = JSON.parse(stdout);
  assert.deepEqual(rep.findings.map((f) => f.id).sort(), ['bundle_key_missing', 'live_key_in_bundle', 'no_ingest_key']);
  assert.equal(rep.bundle.keyPresent, false);
  assert.equal(code, 0);
  const strict = await runCli([project, '--strict', '--bundle', appPath]);
  assert.equal(strict.code, 1);
  const scan = scanProject(project, { bundle: appPath });
  assert.equal(resolveKey({ scan }).key, null);
});

test('regression: an encrypted member, a ZIP64 archive and an archive nested too deep are never taken as clean', (t) => {
  const enc = zip({ 'main.lua': `k="${LIVE}"`, 'conf.lua': 'x' }, { encrypted: ['main.lua'] });
  const z64 = zip({ 'main.lua': `k="${LIVE}"` });
  z64.writeUInt16LE(0xffff, z64.length - 22 + 10);
  let deep = zip({ 'main.lua': `k="${LIVE}"` });
  for (let i = 0; i < 4; i++) deep = zip({ [`level${i}.zip`]: deep });
  const dir = makeProject(t, { 'enc.love': enc, 'z64.zip': z64, 'deep.zip': deep });
  for (const [name, member] of [['enc.love', /enc\.love!\/main\.lua/], ['z64.zip', /z64\.zip/], ['deep.zip', /level/]]) {
    const r = checkBundle(path.join(dir, name));
    const [f] = only(r, 'bundle_not_fully_read');
    assert.ok(f, name);
    assert.equal(f.severity, 'warning');
    assert.match(f.detail, member);
    assert.equal(r.finding.id, 'bundle_key_missing', name);
    assert.ok(r.unreadable >= 1);
  }
});

test('regression: missing path and empty directory still exit 2; a source plist still warns bundle_key_missing', async (t) => {
  const project = swiftProject(t);
  const empty = makeProject(t, {});
  for (const target of [path.join(empty, 'nope.app'), empty]) {
    const { code } = await runCli([project, '--bundle', target]);
    assert.equal(code, 2, target);
  }
  const src = await runCli([project, '--json', '--strict', '--bundle', path.join(BUNDLES, 'Info-source.plist')]);
  assert.equal(src.code, 1);
  assert.ok(JSON.parse(src.stdout).findings.some((f) => f.id === 'bundle_key_missing'));
});

test('redactKeys cuts any gt_ token to its prefix and eight characters', () => {
  assert.equal(redactKeys(`a/${LIVE}.js`), 'a/gt_live_Zq9xK2mW....js');
  assert.equal(redactKeys(PUB), 'gt_pub_A0sJ5gF1...');
  assert.equal(redactKeys('gt_live_short'), 'gt_live_short');
});

/** Every key secret part that must never be printed: the whole key and anything past eight characters. */
function assertNoKey(text, where) {
  for (const k of [LIVE, PUB]) {
    const tail = k.slice(k.indexOf('_', 3) + 1);
    assert.ok(!text.includes(tail.slice(0, 9)), `${where}: more than eight characters of ${k.slice(0, 7)}`);
  }
}

function leakyBuild(t) {
  // Keys in contents, in a disk file name and in an archive member name.
  return makeProject(t, {
    [`web/${LIVE}.js`]: `var a="${LIVE}",c="${PUB}";`,
    [`web/${PUB}.txt`]: 'nothing',
    'Game.love': zip({ [`${LIVE}/main.lua`]: `k="${LIVE}"`, [`${PUB}.lua`]: `p="${PUB}"` }, { encrypted: [`${PUB}.lua`] }),
  });
}

test('disclosure: the checkBundle result, findings, file labels and unreadable names hold no whole key', (t) => {
  const r = checkBundle(leakyBuild(t));
  assertNoKey(JSON.stringify(r), 'result');
  assert.ok(only(r, 'live_key_in_bundle').length >= 2);
  assert.ok(only(r, 'bundle_not_fully_read').length === 1);
});

test('disclosure: pretty output, --json, --strict and the evidence lines hold no whole key', async (t) => {
  const project = swiftProject(t, { ingestKey: { source: 'build' } });
  const build = leakyBuild(t);
  for (const extra of [[], ['--json'], ['--strict'], ['--json', '--strict']]) {
    const { stdout, stderr } = await runCli([project, ...extra, '--bundle', build]);
    assertNoKey(stdout, `stdout ${extra.join(' ')}`);
    assertNoKey(stderr, `stderr ${extra.join(' ')}`);
    if (!extra.includes('--json')) assert.match(stdout, /Static: /);
  }
});

test('disclosure: a --bundle error message holds no whole key', async (t) => {
  const project = swiftProject(t);
  const missing = path.join(makeProject(t, {}), `${LIVE}.app`);
  assert.throws(() => checkBundle(missing), (err) => {
    assertNoKey(err.message, 'BundleError');
    return err instanceof BundleError;
  });
  const { code, stdout, stderr } = await runCli([project, '--bundle', missing]);
  assert.equal(code, 2);
  assertNoKey(stdout + stderr, 'cli error');
});

test('disclosure: the --report submission body holds no whole key', async (t) => {
  const project = swiftProject(t, { ingestKey: { source: 'build' } });
  let body = '';
  const { server, url } = await startServer((req, res) => {
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end('{"stored":true}');
    });
  });
  try {
    const { stdout, stderr } = await runCli([project, '--report', '--api-url', url, '--bundle', leakyBuild(t)]);
    assert.ok(body.length > 0, 'the report was sent');
    assertNoKey(body, 'report body');
    assertNoKey(stdout + stderr, 'report output');
  } finally {
    server.close();
  }
});
