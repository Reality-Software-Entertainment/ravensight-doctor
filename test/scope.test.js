import test from 'node:test';
import assert from 'node:assert/strict';
import { scanProject } from '../lib/cli.js';
import { buildReport, formatPretty } from '../lib/report.js';
import { parseTrackFnSpec, parseTrackFnFlags, ConfigError } from '../lib/config.js';
import { stripComments } from '../lib/comments.js';
import { inCallScope } from '../lib/checks.js';
import { makeProject, byId, runCli } from './helpers.js';

const KEY = 'gt_live_' + 'Qw7eRt5y'.repeat(4); // 32 chars, fake
const JS_SDK = { 'package.json': JSON.stringify({ dependencies: { ravensight: '^0.3.0' } }) };

function names(scan) {
  return scan.inventory.eventNames.map((e) => e.name).sort();
}

function status(scan) {
  return buildReport(scan.engine, scan.findings, scan.totals, '0.3.0', { inventory: scan.inventory }).summary.status;
}

// Comments

test('stripComments keeps length and newlines, and leaves strings alone', () => {
  const js = 'a(); // rs.track("x")\nb("http://x"); /* one\ntwo */ c();\n';
  const out = stripComments(js, 'a.js');
  assert.equal(out.length, js.length);
  assert.deepEqual(
    out.split('\n').map((l) => l.trimEnd()),
    ['a();', 'b("http://x");', '       c();', ''],
  );
  const lua = 'x() -- ravensight.track("a")\n--[==[ block\nravensight.track("b") ]==] y()\n';
  const luaOut = stripComments(lua, 'main.lua');
  assert.equal(luaOut.length, lua.length);
  assert.ok(!luaOut.includes('track'));
  assert.ok(luaOut.includes('y()'));
  assert.equal(stripComments('# rs.track("a")\nrs.track("b")', 'a.gd'), '               \nrs.track("b")');
  assert.equal(stripComments('; rs.track("a")', 'boot.asm'), '; rs.track("a")');
});

test('a commented JS call is not counted, and later lines keep their numbers', (t) => {
  const dir = makeProject(t, {
    ...JS_SDK,
    'src/game.js': [
      '// rs.track("commented_line")',
      '/* rs.track("commented_block")',
      '   rs.track("still_commented") */',
      'rs.track("real_call"); // rs.track("trailing")',
    ].join('\n'),
  });
  const scan = scanProject(dir);
  assert.deepEqual(names(scan), ['real_call']);
  assert.deepEqual(scan.inventory.trackCalls, [{ file: 'src/game.js', line: 4, form: 'rs.track', name: 'real_call' }]);
});

test('a commented Lua call in a game file is not counted', (t) => {
  const dir = makeProject(t, {
    'main.lua': [
      '-- ravensight.track("level_start", { level = 1 })',
      '--[[',
      'ravensight.track("in_block")',
      ']]',
      'ravensight.track("boot")',
    ].join('\n'),
  });
  const scan = scanProject(dir);
  assert.deepEqual(scan.inventory.trackCalls, [{ file: 'main.lua', line: 5, form: 'ravensight.track', name: 'boot' }]);
});

test('a vendored Lua SDK file at any path is not part of the inventory', (t) => {
  const dir = makeProject(t, {
    'ravensight.lua': 'local M = {}\nfunction M.boot()\n  ravensight.track("sdk_internal")\nend\nreturn M\n',
    'main.lua': 'ravensight.track("boot")\n',
  });
  assert.deepEqual(names(scanProject(dir)), ['boot']);
});

test('a key inside a comment is still a leak', (t) => {
  const dir = makeProject(t, { 'src/a.js': '// old token: gt_mcp_FAKEFAKEFAKE0009\n' });
  assert.equal(byId(scanProject(dir).findings, 'wrong_key_type').length, 1);
});

// Scope

test('call scope: tests, docs, test and doc directories, and vendored SDK directories', () => {
  const out = [
    'src/game.test.js',
    'tests/a.js',
    'spec/a_spec.rb',
    'a/__mocks__/b.js',
    'docs/guide.js',
    'examples/demo.js',
    'README.md',
    'notes.txt',
    'site/index.html',
    'lib/ravensight/init.lua',
    'vendor/ravensight/client.js',
    'addons/ravensight/Ravensight.gd',
  ];
  for (const rel of out) assert.equal(inCallScope(rel), false, rel);
  for (const rel of ['src/game.js', 'scripts/player.gd', 'main.lua', 'src/ravensight_setup.js']) {
    assert.equal(inCallScope(rel), true, rel);
  }
  assert.equal(inCallScope('tests/a.js', { includeTests: true }), true);
  assert.equal(inCallScope('README.md', { includeDocs: true }), true);
  assert.equal(inCallScope('docs/guide.js', { includeDocs: true }), true);
  assert.equal(inCallScope('lib/ravensight/init.lua', { includeTests: true, includeDocs: true }), false);
});

function scopedProject(t) {
  return makeProject(t, {
    ...JS_SDK,
    'src/game.js': 'rs.track("real_call");\n',
    'src/game.test.js': 'rs.track("from_test");\n',
    'tests/e2e.js': 'rs.track("from_tests_dir");\n',
    'README.md': 'Call `rs.track("from_readme")` to send an event.\n',
    'docs/setup.js': 'rs.track("from_docs_dir");\n',
    'lib/ravensight/init.lua': 'function M.boot()\n  ravensight.track("from_vendored_sdk")\nend\n',
    'tests/keys.js': 'const t = "gt_mcp_FAKEFAKEFAKE0010";\n',
  });
}

test('tests, docs and the vendored SDK are left out of the inventory by default', (t) => {
  const scan = scanProject(scopedProject(t));
  assert.deepEqual(names(scan), ['real_call']);
  assert.equal(scan.inventory.filesScannedForCalls, 2); // package.json, src/game.js
  assert.equal(scan.inventory.filesScannedForKeys, 8);
  // Key hygiene still covers the tests directory.
  assert.equal(byId(scan.findings, 'wrong_key_type').length, 1);
});

test('includeTests and includeDocs bring them back, the vendored SDK never', (t) => {
  const dir = scopedProject(t);
  assert.deepEqual(names(scanProject(dir, { includeTests: true })), ['from_test', 'from_tests_dir', 'real_call']);
  assert.deepEqual(names(scanProject(dir, { includeDocs: true })), ['from_docs_dir', 'from_readme', 'real_call']);
});

test('--include-tests, --include-docs and the files scanned counts on the CLI', async (t) => {
  const dir = scopedProject(t);
  const plain = await runCli([dir]);
  assert.ok(plain.stdout.includes('Files:   2 scanned for calls, 8 scanned for keys'), plain.stdout);
  const json = JSON.parse((await runCli([dir, '--json', '--include-tests', '--include-docs'])).stdout);
  assert.equal(json.inventory.filesScannedForCalls, 7); // tests/keys.js too
  assert.equal(json.inventory.filesScannedForKeys, 8);
  assert.deepEqual(json.inventory.eventNames.map((e) => e.name).sort(), [
    'from_docs_dir',
    'from_readme',
    'from_test',
    'from_tests_dir',
    'real_call',
  ]);
});

// Specs

test('parseTrackFnSpec: @N, Lua method names, and the limits', () => {
  assert.deepEqual(parseTrackFnSpec('capture@1'), { name: 'capture', argIndex: 1, source: 'flag' });
  assert.deepEqual(parseTrackFnSpec('telemetry:track'), { name: 'telemetry:track', argIndex: 0, source: 'flag' });
  assert.deepEqual(parseTrackFnSpec('game.telemetry:track@2', 'config'), {
    name: 'game.telemetry:track',
    argIndex: 2,
    source: 'config',
  });
  for (const bad of ['capture@10', 'capture@', '@1', 'a:b:c', 'a:b.c', ':track', 'capture@-1']) {
    assert.throws(() => parseTrackFnSpec(bad), ConfigError, bad);
  }
  assert.deepEqual(parseTrackFnFlags(['capture@1,telemetry:track']).map((s) => [s.name, s.argIndex]), [
    ['capture', 1],
    ['telemetry:track', 0],
  ]);
});

test('capture@1 reads the event name from the second argument', (t) => {
  const dir = makeProject(t, { ...JS_SDK, 'src/a.js': 'capture(userId, "level_start");\ncapture(userId, "level_end");\n' });
  const scan = scanProject(dir, { trackFunctions: [parseTrackFnSpec('capture@1')] });
  assert.deepEqual(names(scan), ['level_end', 'level_start']);
  assert.equal(scan.inventory.unresolvedCalls, 0);
});

test('a Lua method spec matches colon and dot calls, never definitions', (t) => {
  const dir = makeProject(t, {
    'telemetry.lua': [
      'local telemetry = {}',
      'function telemetry:track(name, data) end',
      'function telemetry.track(name, data) end',
      'local function track(name) end',
      'function track(name) end',
      'return telemetry',
    ].join('\n'),
    'main.lua': 'telemetry:track("level_start")\ntelemetry.track("level_end")\n',
  });
  const scan = scanProject(dir, { trackFunctions: parseTrackFnFlags(['telemetry:track', 'track']) });
  assert.deepEqual(
    scan.inventory.trackCalls.map((c) => [c.file, c.line, c.form, c.name]),
    [
      ['main.lua', 1, 'telemetry:track', 'level_start'],
      ['main.lua', 2, 'telemetry:track', 'level_end'],
    ],
  );
});

test('--track-fn telemetry:track is accepted on the CLI', async (t) => {
  const dir = makeProject(t, { 'main.lua': 'telemetry:track("boot")\n' });
  const { code, stdout } = await runCli([dir, '--json', '--track-fn', 'telemetry:track']);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout).inventory.eventNames, [{ name: 'boot', count: 1 }]);
});

test('overlapping specs count a call once, credited to the most specific', (t) => {
  const dir = makeProject(t, {
    ...JS_SDK,
    'src/a.js': 'rs.track("a"); Analytics.track("b"); track("c");\nfunction track(name) {}\n',
  });
  const scan = scanProject(dir, { trackFunctions: parseTrackFnFlags(['track', 'Analytics.track']) });
  assert.deepEqual(
    scan.inventory.trackCalls.map((c) => [c.line, c.form, c.name]),
    [
      [1, 'rs.track', 'a'],
      [1, 'Analytics.track', 'b'],
      [1, 'track', 'c'],
    ],
  );
  const counts = Object.fromEntries(scan.inventory.trackFunctions.map((f) => [f.name, f.calls]));
  assert.equal(counts['rs.track'], 1);
  assert.equal(counts['Analytics.track'], 1);
  assert.equal(counts.track, 1);
});

// Status

function mixed(t, literal, variable) {
  const lines = [];
  for (let i = 0; i < literal; i++) lines.push(`rs.track("event_${String.fromCharCode(97 + i)}");`);
  for (let i = 0; i < variable; i++) lines.push('rs.track(eventName);');
  return makeProject(t, { ...JS_SDK, 'src/key.js': `export const key = "${KEY}";\n`, 'src/a.js': lines.join('\n') + '\n' });
}

test('25 percent rule: 1 of 4 unresolved is inconclusive, 1 of 5 is warn', (t) => {
  const four = scanProject(mixed(t, 3, 1));
  assert.equal(byId(four.findings, 'tracking_unverified').length, 0);
  assert.equal(byId(four.findings, 'tracking_unresolved').length, 1);
  assert.equal(status(four), 'inconclusive');
  assert.match(byId(four.findings, 'tracking_unresolved')[0].detail, /1 of 4 .*25 percent/);

  const five = scanProject(mixed(t, 4, 1));
  const unres = byId(five.findings, 'tracking_unresolved');
  assert.equal(unres.length, 1);
  assert.equal(unres[0].severity, 'warning');
  assert.equal(unres[0].file, 'src/a.js');
  assert.equal(unres[0].line, 5);
  assert.match(unres[0].detail, /src\/a\.js:5/);
  assert.equal(status(five), 'warn');

  assert.equal(status(scanProject(mixed(t, 4, 0))), 'pass');
});

test('tracking_unresolved lists at most 20 locations', (t) => {
  const scan = scanProject(mixed(t, 0, 30));
  const detail = byId(scan.findings, 'tracking_unresolved')[0].detail;
  assert.equal((detail.match(/src\/a\.js:\d+/g) || []).length, 20);
  assert.match(detail, /and 10 more/);
  assert.ok(detail.length <= 1000);
});

test('--strict exits 1 on an inconclusive share and on a warn', async (t) => {
  const inconclusive = await runCli([mixed(t, 3, 1)]);
  assert.equal(inconclusive.code, 0);
  assert.ok(inconclusive.stdout.includes('Status:  inconclusive'));
  assert.equal((await runCli([mixed(t, 3, 1), '--strict'])).code, 1);
  assert.equal((await runCli([mixed(t, 4, 1), '--strict'])).code, 1);
  assert.equal((await runCli([mixed(t, 4, 0), '--strict'])).code, 0);
});

test('the pretty inventory explains forwarded and unresolved calls', (t) => {
  const scan = scanProject(mixed(t, 4, 1));
  const out = formatPretty(buildReport(scan.engine, scan.findings, scan.totals, '0.3.0', { inventory: scan.inventory }), {});
  assert.ok(out.includes('Track calls:  5 (4 with a literal name, 1 unresolved)'));
  assert.ok(!/[–—]/.test(out));
});
