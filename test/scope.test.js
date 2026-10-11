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
    'docs/index.html',
    'lib/ravensight/init.lua',
    'vendor/ravensight/client.js',
    'addons/ravensight/Ravensight.gd',
  ];
  for (const rel of out) assert.equal(inCallScope(rel), false, rel);
  for (const rel of ['src/game.js', 'scripts/player.gd', 'main.lua', 'src/analytics_setup.js', 'site/index.html', 'web/page.htm']) {
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
  assert.ok(
    plain.stdout.includes(
      '6 files left out of the call scan: 3 test files, 2 docs files, 1 vendored SDK file; use --include-tests or --include-docs to scan them',
    ),
    plain.stdout,
  );
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

// Fix round 1

test('parameterNames drops types, defaults and self', async () => {
  const { parameterNames } = await import('../lib/wrappers.js');
  const got = (s) => [...parameterNames(s)];
  assert.deepEqual(got('name: String, data := {}'), ['name', 'data']);
  assert.deepEqual(got('self, name, data=None'), ['name', 'data']);
  assert.deepEqual(got('string name, Dictionary<string, object> data = null'), ['name', 'data']);
  assert.deepEqual(got('const std::string& name'), ['name']);
  assert.deepEqual(got('_ name: String'), ['name']);
});

test('a forwarding call outside the wrapper body stays unresolved', (t) => {
  const dir = makeProject(t, {
    ...JS_SDK,
    'src/key.js': `export const key = "${KEY}";\n`,
    'src/analytics.js': [
      'export function logEvent(name) {',
      '  rs.track(name);',
      '}',
      'function other(name) {',
      '  rs.track(name);',
      '}',
    ].join('\n'),
    'src/game.js': 'logEvent("a");\nlogEvent("b");\nlogEvent("c");\nlogEvent("d");\nlogEvent("e");\nlogEvent("f");\n',
  });
  const scan = scanProject(dir, { trackFunctions: [parseTrackFnSpec('logEvent')] });
  const inner = scan.inventory.trackCalls.filter((c) => c.file === 'src/analytics.js');
  assert.deepEqual(inner.map((c) => [c.line, Boolean(c.forwarded)]), [
    [2, true],
    [5, false],
  ]);
  assert.equal(scan.inventory.unresolvedCalls, 1);
  assert.match(byId(scan.findings, 'tracking_unresolved')[0].detail, /src\/analytics\.js:5/);
});

function gdWrapperProject(t, extraBody = '') {
  return makeProject(t, {
    'project.godot': 'config_version=5\n',
    'addons/ravensight/Ravensight.gd': 'extends Node\nfunc track(n, d := {}):\n\treturn true\n',
    'scripts/setup.gd': `extends Node\nfunc _ready():\n\tRavensight.ingest_key = "${KEY}"\n`,
    'scripts/analytics.gd':
      'extends Node\n\nfunc log_event(name: String, data := {}) -> void:\n\tRavensight.track(name, data)\n' + extraBody,
    'scripts/game.gd': 'extends Node\nfunc go():\n\tAnalytics.log_event("a")\n\tAnalytics.log_event("b")\n\tAnalytics.log_event("c")\n',
  });
}

test('a dotted spec finds its wrapper by the last segment: 3 literal plus 1 forwarded is pass', (t) => {
  const scan = scanProject(gdWrapperProject(t), { trackFunctions: [parseTrackFnSpec('Analytics.log_event')] });
  assert.equal(scan.inventory.forwardedCalls, 1);
  assert.equal(scan.inventory.unresolvedCalls, 0);
  assert.deepEqual(names(scan), ['a', 'b', 'c']);
  assert.equal(status(scan), 'pass');
});

test('an indented body ends at the next definition', (t) => {
  const scan = scanProject(gdWrapperProject(t, '\nfunc other(name):\n\tRavensight.track(name)\n'), {
    trackFunctions: [parseTrackFnSpec('Analytics.log_event')],
  });
  assert.equal(scan.inventory.forwardedCalls, 1);
  assert.equal(scan.inventory.unresolvedCalls, 1);
});

test('a Lua wrapper body ends at its end', (t) => {
  const dir = makeProject(t, {
    'telemetry.lua': [
      'function telemetry:track(name, data)',
      '  if name then ravensight.track(name, data) end',
      'end',
      'function other(name) ravensight.track(name) end',
    ].join('\n'),
  });
  const scan = scanProject(dir, { trackFunctions: [parseTrackFnSpec('telemetry:track')] });
  assert.deepEqual(scan.inventory.trackCalls.map((c) => [c.line, Boolean(c.forwarded)]), [
    [2, true],
    [4, false],
  ]);
});

test('a "/*" inside a regex literal does not blank the rest of the file', (t) => {
  const js =
    'const p = s.replace(/\\/*$/, "");\nrs.track("lost");\n' +
    'const q = s.replace(/[/*]/g, "");\nrs.track("after_charclass");\n' +
    'x = 1; /* start\nrs.track("hidden")\n*/\n';
  const dir = makeProject(t, { ...JS_SDK, 'src/a.js': js });
  assert.deepEqual(names(scanProject(dir)), ['after_charclass', 'lost']);
});

test('track_fn_unused stays quiet when the form matched but lost the dedupe', (t) => {
  const dir = makeProject(t, { ...JS_SDK, 'src/a.js': 'rs.track("a");\nrs.track("b");\n' });
  const scan = scanProject(dir, { trackFunctions: [parseTrackFnSpec('track')] });
  assert.equal(byId(scan.findings, 'track_fn_unused').length, 0);
  assert.ok(scan.inventory.trackCalls.every((c) => c.form === 'rs.track'));
});

test('test and docs directory names match in any case, and spec counts for keys too', async () => {
  const { isTestPath } = await import('../lib/checks.js');
  for (const rel of ['Assets/Tests/Foo.cs', 'Docs/guide.js', 'Examples/a.js', 'Spec/a.rb', 'x/Game.Test.js']) {
    assert.equal(inCallScope(rel), false, rel);
  }
  assert.equal(isTestPath('Assets/Tests/Keys.cs'), true);
  assert.equal(isTestPath('spec/keys_spec.rb'), true);
  assert.equal(isTestPath('specs/a.js'), true);
});

test('only vendored SDK files left out: no include hint', async (t) => {
  const dir = makeProject(t, { ...JS_SDK, 'src/game.js': 'rs.track("a");\n', 'vendor/ravensight/client.js': 'rs.track("x");\n' });
  const { stdout } = await runCli([dir]);
  assert.ok(stdout.includes('1 file left out of the call scan: 1 vendored SDK file\n'), stdout);
  assert.ok(!stdout.includes('--include-'));
});

// 0.3.1: wrappers assigned to a name, field or property

function forwardedLines(scan, file) {
  return scan.inventory.trackCalls.filter((c) => c.file === file).map((c) => [c.line, Boolean(c.forwarded)]);
}

const ASSIGNED_FORMS = [
  {
    what: 'a Lua table constructor field',
    spec: 'track',
    file: 'main.lua',
    lines: [
      'local Analytics = {',
      '  track = function(n, d) get().track(n, d) end,',
      '}',
      'function other(n) get().track(n) end',
    ],
    expect: [
      [2, true],
      [4, false],
    ],
  },
  {
    what: 'a Lua module field',
    spec: 'Analytics.track',
    file: 'analytics.lua',
    lines: [
      'M.track = function(name, data)',
      '  if name then ravensight.track(name, data) end',
      'end',
      'function other(name) ravensight.track(name) end',
    ],
    expect: [
      [2, true],
      [4, false],
    ],
  },
  {
    what: 'a JS object property function',
    spec: 'Analytics.track',
    file: 'src/analytics.js',
    lines: [
      'export const Analytics = {',
      '  track: function (name, data) {',
      '    rs.track(name, data);',
      '  },',
      '};',
      'function other(name) { rs.track(name); }',
    ],
    expect: [
      [3, true],
      [6, false],
    ],
  },
  {
    what: 'JS method shorthand in a class',
    spec: 'Analytics.track',
    file: 'src/analytics.js',
    lines: [
      'class Analytics {',
      '  track(name, data) {',
      '    rs.track(name, data);',
      '  }',
      '}',
      'function other(name) { rs.track(name); }',
    ],
    expect: [
      [3, true],
      [6, false],
    ],
  },
  {
    what: 'a JS arrow function with an expression body',
    spec: 'track',
    file: 'src/analytics.js',
    lines: [
      'export const track = (name, data) => rs.track(name, data)',
      'export const hit = (name) =>',
      '  rs.track(name);',
      'function other(name) { rs.track(name); }',
    ],
    expect: [
      [1, true],
      [3, false],
      [4, false],
    ],
  },
];

for (const form of ASSIGNED_FORMS) {
  test(`a wrapper defined as ${form.what} forwards, and a later function with the same parameter does not`, (t) => {
    const dir = makeProject(t, { [form.file]: form.lines.join('\n') + '\n' });
    const scan = scanProject(dir, { trackFunctions: [parseTrackFnSpec(form.spec)] });
    assert.deepEqual(forwardedLines(scan, form.file), form.expect);
  });
}

test('a JS arrow wrapper in an object literal ends at its comma', (t) => {
  const dir = makeProject(t, {
    'src/a.js': 'const A = { track: (name) => rs.track(name), other: (name) => rs.track(name) };\n',
  });
  const scan = scanProject(dir, { trackFunctions: [parseTrackFnSpec('track')] });
  const calls = scan.inventory.trackCalls.filter((c) => c.file === 'src/a.js');
  assert.deepEqual(calls.map((c) => Boolean(c.forwarded)), [true, false]);
});

test('an arrow wrapper with a braced body ends at its brace', (t) => {
  const dir = makeProject(t, {
    'src/a.js': 'const track = async name => {\n  rs.track(name);\n};\nconst other = (name) => { rs.track(name); };\n',
  });
  const scan = scanProject(dir, { trackFunctions: [parseTrackFnSpec('track')] });
  assert.deepEqual(forwardedLines(scan, 'src/a.js'), [
    [2, true],
    [4, false],
  ]);
});

test('a call assigned to the wrapper name is not a definition', (t) => {
  const dir = makeProject(t, { 'src/a.js': 'track = (name);\nrs.track(name);\nok = track == (name) && rs.track(name);\n' });
  const scan = scanProject(dir, { trackFunctions: [parseTrackFnSpec('track')] });
  assert.ok(scan.inventory.trackCalls.every((c) => !c.forwarded));
});

// 0.3.1: HTML pages

test('an HTML page is scanned inside its script elements only', (t) => {
  const page = [
    '<!doctype html>',
    '<p>Call rs.track("page_text") to send an event.</p>',
    '<!-- <script>rs.track("in_comment")</script> -->',
    '<!--',
    'rs.track("in_long_comment")',
    '-->',
    '<script type="module">',
    '  // rs.track("js_comment")',
    "  rs.track('game_started');",
    '</script>',
    '<pre>rs.track("after_script")</pre>',
    '<SCRIPT>rs.track("upper_case")</SCRIPT>',
  ].join('\n');
  const dir = makeProject(t, { 'tools/web/index.html': page });
  const scan = scanProject(dir);
  assert.equal(scan.inventory.filesScannedForCalls, 1);
  assert.deepEqual(
    scan.inventory.trackCalls.map((c) => [c.file, c.line, c.name]),
    [
      ['tools/web/index.html', 9, 'game_started'],
      ['tools/web/index.html', 12, 'upper_case'],
    ],
  );
});

test('an HTML page under docs is counted and named in the left out line', async (t) => {
  const dir = makeProject(t, {
    ...JS_SDK,
    'src/game.js': 'rs.track("a");\n',
    'docs/index.html': '<script>rs.track("from_docs_page")</script>\n',
    'docs/guide.md': 'rs.track("x")\n',
  });
  const scan = scanProject(dir);
  assert.equal(scan.inventory.filesLeftOutOfCallScan.docs, 2);
  assert.deepEqual(scan.inventory.htmlLeftOutOfCallScan, { count: 1, files: ['docs/index.html'] });
  const { stdout } = await runCli([dir]);
  assert.ok(stdout.includes('2 files left out of the call scan: 2 docs files (HTML: docs/index.html); use --include-docs'), stdout);
  assert.ok(!/[–—]/.test(stdout));
});
