import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { scanProject } from '../lib/cli.js';
import { compileIgnore } from '../lib/ignore.js';
import { createReader, walkFiles } from '../lib/scan.js';
import { loadConfig, ConfigError } from '../lib/config.js';
import { makeProject, byId } from './helpers.js';

const SDK = {
  'project.godot': 'config_version=5\n',
  'addons/ravensight/Ravensight.gd': 'extends Node\nfunc track(n, d := {}):\n\treturn true\n',
};

function rels(dir, opts) {
  return walkFiles(dir, opts).map((f) => f.rel);
}

test('compileIgnore: basename patterns match at any depth', () => {
  const ig = compileIgnore('*.log\nsecrets.txt\n');
  assert.equal(ig('debug.log', false), true);
  assert.equal(ig('a/b/debug.log', false), true);
  assert.equal(ig('a/secrets.txt', false), true);
  assert.equal(ig('a/secrets.txt.bak', false), false);
  assert.equal(ig('a/logs', true), false);
});

test('compileIgnore: a leading or middle slash anchors to the root', () => {
  const ig = compileIgnore('/out\ndocs/*.md\n');
  assert.equal(ig('out', true), true);
  assert.equal(ig('src/out', true), false);
  assert.equal(ig('docs/a.md', false), true);
  assert.equal(ig('docs/x/a.md', false), false);
  assert.equal(ig('src/docs/a.md', false), false);
});

test('compileIgnore: ** spans directories', () => {
  const ig = compileIgnore('**/cache\ngen/**\na/**/b\n');
  assert.equal(ig('cache', true), true);
  assert.equal(ig('x/y/cache', true), true);
  assert.equal(ig('gen/a/b.js', false), true);
  assert.equal(ig('gen', true), false);
  assert.equal(ig('a/b', false), true);
  assert.equal(ig('a/x/y/b', false), true);
  assert.equal(ig('z/a/b', false), false);
});

test('compileIgnore: trailing slash is directory only, ? is one character', () => {
  const ig = compileIgnore('tmpdir/\nfile?.txt\n');
  assert.equal(ig('tmpdir', true), true);
  assert.equal(ig('tmpdir', false), false);
  assert.equal(ig('file1.txt', false), true);
  assert.equal(ig('file12.txt', false), false);
});

test('compileIgnore: comments, blanks and negations are skipped', () => {
  const ig = compileIgnore(['# comment', '', '   ', '!keep.log', '*.log']);
  assert.equal(ig('keep.log', false), true);
  assert.equal(compileIgnore('!x\n#y\n')('x', false), false);
});

test('coverage, .next and the other build caches are never scanned', (t) => {
  const dir = makeProject(t, {
    ...SDK,
    'coverage/lcov-report/index.js': 'gt_mcp_FAKEFAKEFAKE0101\n',
    '.next/server/page.js': 'gt_mcp_FAKEFAKEFAKE0102\n',
    '.playwright-mcp/trace.txt': 'gt_mcp_FAKEFAKEFAKE0103\n',
    '.svelte-kit/out.js': 'gt_mcp_FAKEFAKEFAKE0104\n',
    'tmp/scratch.txt': 'gt_mcp_FAKEFAKEFAKE0105\n',
  });
  const scan = scanProject(dir);
  assert.equal(byId(scan.findings, 'wrong_key_type').length, 0);
});

test('skipped extensions and lockfiles are never read', (t) => {
  const dir = makeProject(t, {
    ...SDK,
    'art/logo.png': 'gt_mcp_FAKEFAKEFAKE0201\n',
    'web/app.min.js': 'gt_mcp_FAKEFAKEFAKE0202\n',
    'web/app.js.map': 'gt_mcp_FAKEFAKEFAKE0203\n',
    'logs/run.log': 'gt_mcp_FAKEFAKEFAKE0204\n',
    'package-lock.json': '{"x":"gt_mcp_FAKEFAKEFAKE0205"}\n',
    'sub/yarn.lock': 'gt_mcp_FAKEFAKEFAKE0206\n',
  });
  const files = rels(dir);
  for (const skipped of ['art/logo.png', 'web/app.min.js', 'web/app.js.map', 'logs/run.log', 'package-lock.json', 'sub/yarn.lock']) {
    assert.ok(!files.includes(skipped), skipped);
  }
  assert.equal(byId(scanProject(dir).findings, 'wrong_key_type').length, 0);
});

test('the root .gitignore is honoured, and --no-gitignore turns it off', (t) => {
  const dir = makeProject(t, {
    ...SDK,
    '.gitignore': '# local junk\nprivate/\n*.bak\n',
    'private/notes.txt': 'gt_mcp_FAKEFAKEFAKE0301\n',
    'scripts/old.gd.bak': 'gt_mcp_FAKEFAKEFAKE0302\n',
  });
  assert.equal(byId(scanProject(dir).findings, 'wrong_key_type').length, 0);
  assert.equal(byId(scanProject(dir, { gitignore: false }).findings, 'wrong_key_type').length, 2);
});

test('--ignore patterns are applied on top of the defaults', (t) => {
  const dir = makeProject(t, {
    ...SDK,
    'vendor/lib.gd': 'gt_mcp_FAKEFAKEFAKE0401\n',
    'other/lib.gd': 'gt_mcp_FAKEFAKEFAKE0402\n',
  });
  const scan = scanProject(dir, { ignore: ['vendor/'] });
  const wrong = byId(scan.findings, 'wrong_key_type');
  assert.equal(wrong.length, 1);
  assert.equal(wrong[0].file, 'other/lib.gd');
});

test('ravensight.config.json supplies ignore and gitignore', (t) => {
  const dir = makeProject(t, {
    ...SDK,
    '.gitignore': 'private/\n',
    'private/notes.txt': 'gt_mcp_FAKEFAKEFAKE0501\n',
    'vendor/lib.gd': 'gt_mcp_FAKEFAKEFAKE0502\n',
    'ravensight.config.json': JSON.stringify({ ignore: ['vendor'], gitignore: false }),
  });
  const wrong = byId(scanProject(dir).findings, 'wrong_key_type');
  assert.deepEqual(wrong.map((f) => f.file), ['private/notes.txt']);
});

test('loadConfig: absent file is an empty config', (t) => {
  const dir = makeProject(t, { 'a.txt': 'x' });
  assert.deepEqual(loadConfig(dir), { trackFunctions: [], ignore: [], gitignore: undefined });
});

test('loadConfig: malformed JSON and wrong types throw ConfigError', (t) => {
  const bad = makeProject(t, { 'ravensight.config.json': '{ nope' });
  assert.throws(() => loadConfig(bad), ConfigError);
  const wrongType = makeProject(t, { 'ravensight.config.json': '{"ignore": "vendor"}' });
  assert.throws(() => loadConfig(wrongType), (e) => e instanceof ConfigError && /ignore/.test(e.message));
  const wrongGit = makeProject(t, { 'ravensight.config.json': '{"gitignore": "no"}' });
  assert.throws(() => loadConfig(wrongGit), ConfigError);
  const unknown = makeProject(t, { 'ravensight.config.json': '{"ignroe": []}' });
  assert.throws(() => loadConfig(unknown), (e) => e instanceof ConfigError && /ignroe/.test(e.message));
});

test('read cache: every file is read from disk once per scan', (t) => {
  const dir = makeProject(t, {
    'package.json': JSON.stringify({ dependencies: { ravensight: '^0.3.0' } }),
    'src/game.js': 'rs.track("boot")\n',
  });
  const scan = scanProject(dir);
  assert.equal(scan.readStats.diskReads, scan.filesScanned);
  assert.ok(scan.readStats.hits >= 1, 'package.json is served from the cache the second time');
});

test('read cache: past the byte budget files are re-read instead of cached', (t) => {
  const dir = makeProject(t, { 'a.txt': 'hello world\n' });
  const read = createReader(dir, { maxBytes: 4 });
  assert.equal(read('a.txt'), 'hello world\n');
  assert.equal(read('a.txt'), 'hello world\n');
  assert.equal(read.stats.diskReads, 2);
  assert.equal(read.stats.hits, 0);
});

test('read cache: binary files read as null without reading the whole file', (t) => {
  const dir = makeProject(t, { 'a.txt': 'x' });
  fs.writeFileSync(`${dir}/blob.dat`, Buffer.concat([Buffer.from([0, 1, 2]), Buffer.alloc(100000, 65)]));
  const read = createReader(dir);
  assert.equal(read('blob.dat'), null);
  assert.equal(read('blob.dat'), null);
  assert.equal(read.stats.diskReads, 1);
});
