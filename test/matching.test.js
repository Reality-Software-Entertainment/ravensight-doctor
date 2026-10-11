// 0.3.2: per path track functions, bare versus qualified names, comment
// stripping gaps, and two literal ternaries.

import test from 'node:test';
import assert from 'node:assert/strict';
import { scanProject } from '../lib/cli.js';
import { formatPretty, buildReport } from '../lib/report.js';
import { parseTrackFnSpec, parseTrackFnFlags, loadConfig, ConfigError } from '../lib/config.js';
import { compilePathPattern } from '../lib/ignore.js';
import { isQualified } from '../lib/checks.js';
import { stripComments } from '../lib/comments.js';
import { makeProject, byId, fixture, runCli } from './helpers.js';

const JS_SDK = { 'package.json': JSON.stringify({ dependencies: { ravensight: '^0.3.0' } }) };

function calls(scan) {
  return scan.inventory.trackCalls.map((c) => [c.file, c.line, c.form, c.name, c.names ?? null]);
}

function names(scan) {
  return scan.inventory.eventNames.map((e) => e.name).sort();
}

// 1. paths on trackFunctions entries

test('compilePathPattern covers files under a directory and ranks by literal characters', () => {
  const server = compilePathPattern('server/**');
  assert.equal(server.test('server/a.js'), true);
  assert.equal(server.test('server/api/a.js'), true);
  assert.equal(server.test('dashboard/server.js'), false);
  for (const p of ['server', 'server/', '/server']) {
    assert.equal(compilePathPattern(p).test('server/api/a.js'), true, p);
  }
  assert.equal(compilePathPattern('server/').test('server'), false);
  assert.equal(compilePathPattern('*.ts').test('a/b/c.ts'), true);
  assert.equal(compilePathPattern('src/*.ts').test('src/b/c.ts'), false);
  assert.ok(compilePathPattern('server/api/**').specificity > server.specificity);
});

test('the customer fixture: each file resolves with its own argIndex', () => {
  const scan = scanProject(fixture('two-wrappers-project'));
  const byFile = scan.inventory.trackCalls.filter((c) => c.form === 'capture' && !c.forwarded);
  assert.deepEqual(
    byFile.map((c) => [c.file, c.line, c.name, c.names ?? null, c.paths ?? null]),
    [
      ['dashboard/src/telemetry.js', 8, 'shop_opened', null, ['dashboard/**']],
      ['server/events.js', 8, 'match_finished', null, ['server/**']],
      ['server/events.js', 9, null, ['playoff_round_cleared', 'playoff_eliminated'], ['server/**']],
      ['tools/seed.js', 2, null, null, null],
    ],
  );
  // The qualified analytics.capture call is not the bare wrapper.
  assert.ok(!names(scan).includes('page_view_from_other_tool'));
  assert.ok(!scan.inventory.trackCalls.some((c) => c.line === 10 && c.file.startsWith('dashboard')));
  // tools/seed.js matches no paths entry and there is no entry without paths.
  const outside = scan.inventory.trackCalls.find((c) => c.file === 'tools/seed.js');
  assert.equal(outside.outsidePaths, true);
  assert.equal(scan.inventory.callsOutsidePaths, 1);
  const unresolved = byId(scan.allFindings, 'tracking_unresolved');
  assert.equal(unresolved.length, 1);
  assert.match(unresolved[0].detail, /tools\/seed\.js:2/);
  assert.match(unresolved[0].detail, /1 of them is a call to capture in files that no trackFunctions paths/);
  // Each entry is listed with its paths and its own call count.
  const rows = scan.inventory.trackFunctions.filter((f) => f.name === 'capture');
  assert.deepEqual(rows, [
    { name: 'capture', argIndex: 1, source: 'config', calls: 2, paths: ['server/**'] },
    { name: 'capture', argIndex: 0, source: 'config', calls: 1, paths: ['dashboard/**'] },
  ]);
  const pretty = formatPretty(buildReport(scan.engine, scan.findings, scan.totals, '0.3.2', { inventory: scan.inventory }));
  assert.match(pretty, /capture \(server\/\*\*\) 2, capture \(dashboard\/\*\*\) 1/);
});

test('a file matching no paths entry falls back to the entry without paths', (t) => {
  const dir = makeProject(t, {
    ...JS_SDK,
    'ravensight.config.json': JSON.stringify({
      trackFunctions: [{ name: 'capture', argIndex: 1, paths: ['server/**'] }, 'capture'],
    }),
    'server/a.js': 'capture(user, "server_event");\n',
    'tools/b.js': 'capture("tool_event", user);\n',
  });
  const scan = scanProject(dir);
  assert.deepEqual(names(scan), ['server_event', 'tool_event']);
  assert.equal(scan.inventory.unresolvedCalls, 0);
  assert.deepEqual(
    scan.inventory.trackFunctions.filter((f) => f.name === 'capture').map((f) => [f.argIndex, f.paths ?? null, f.calls]),
    [
      [1, ['server/**'], 1],
      [0, null, 1],
    ],
  );
});

test('the most specific matching paths entry wins, the earlier one on a tie', (t) => {
  const dir = makeProject(t, {
    ...JS_SDK,
    'ravensight.config.json': JSON.stringify({
      trackFunctions: [
        { name: 'capture', argIndex: 0, paths: ['server/**'] },
        { name: 'capture', argIndex: 1, paths: ['server/api/**'] },
        { name: 'capture', argIndex: 2, paths: ['*.mjs'] },
        { name: 'capture', argIndex: 3, paths: ['*.cjs'] },
      ],
    }),
    'server/a.js': 'capture("outer", x);\n',
    'server/api/b.js': 'capture(x, "inner");\n',
    'lib/c.mjs': 'capture(x, y, "module");\n',
  });
  const scan = scanProject(dir);
  assert.deepEqual(names(scan), ['inner', 'module', 'outer']);
  const unused = byId(scan.findings, 'track_fn_unused');
  assert.equal(unused.length, 1);
  assert.match(unused[0].detail, /"capture" for paths \*\.cjs/);
});

test('two entries without paths that share a name are a ConfigError naming both', (t) => {
  const dir = makeProject(t, {
    'ravensight.config.json': JSON.stringify({ trackFunctions: ['capture', 'logEvent', { name: 'capture', argIndex: 1 }] }),
  });
  assert.throws(
    () => loadConfig(dir),
    (err) => err instanceof ConfigError && /trackFunctions\[0\] \("capture"\) and trackFunctions\[2\] \("capture"\)/.test(err.message),
  );
  assert.throws(() => parseTrackFnFlags(['capture', 'capture@1']), /--track-fn capture and --track-fn capture@1/);
});

test('the CLI exits 2 on duplicate entries and on bad paths', async (t) => {
  const dup = makeProject(t, { 'ravensight.config.json': JSON.stringify({ trackFunctions: ['capture', 'capture@1'] }) });
  const r1 = await runCli([dup]);
  assert.equal(r1.code, 2);
  assert.match(r1.stderr, /both name the track function "capture" without paths/);
  for (const paths of [[], 'server/**', [''], ['!server/**'], [5]]) {
    assert.throws(() => parseTrackFnSpec({ name: 'capture', paths }), ConfigError, JSON.stringify(paths));
  }
  const config = loadConfig(
    makeProject(t, { 'ravensight.config.json': JSON.stringify({ trackFunctions: [{ name: 'capture', paths: ['a/**'] }] }) }),
  );
  assert.deepEqual(config.unknownKeys, []);
  assert.deepEqual(config.trackFunctions, [{ name: 'capture', argIndex: 0, source: 'config', paths: ['a/**'] }]);
});

test('a --track-fn without paths adds the fallback to config entries that all have paths', (t) => {
  const dir = makeProject(t, {
    ...JS_SDK,
    'ravensight.config.json': JSON.stringify({ trackFunctions: [{ name: 'capture', argIndex: 1, paths: ['server/**'] }] }),
    'server/a.js': 'capture(user, "server_event");\n',
    'web/b.js': 'capture("web_event");\n',
  });
  const scan = scanProject(dir, { trackFunctions: [parseTrackFnSpec('capture')] });
  assert.deepEqual(names(scan), ['server_event', 'web_event']);
});

// 2. bare, dotted and *. names

test('isQualified: dots, optional chaining, ::, -> and Lua colons', () => {
  assert.equal(isQualified('capture(', 0), false);
  assert.equal(isQualified('a.capture(', 2), true);
  assert.equal(isQualified('a?.capture(', 3), true);
  assert.equal(isQualified('a .  capture(', 5), true);
  assert.equal(isQualified('A::capture(', 3), true);
  assert.equal(isQualified('p->capture(', 3), true);
  assert.equal(isQualified('x ? a : capture(', 8), false);
  assert.equal(isQualified('t:capture(', 2), false);
  assert.equal(isQualified('t:capture(', 2, true), true);
  assert.equal(isQualified('"a" .. capture(', 7, true), false);
  assert.equal(isQualified('f(...capture(', 5), false);
});

test('a bare name matches only unqualified calls', (t) => {
  const dir = makeProject(t, {
    ...JS_SDK,
    'src/a.js': [
      'capture("bare");',
      'analytics.capture("member");',
      'client?.capture("optional");',
      'client\n  .capture("chained");',
      'const e = won ? capture("in_ternary") : null;',
      'Game::capture("scoped");',
    ].join('\n'),
    'main.lua': 'telemetry:capture("lua_method")\ncapture("lua_bare")\n',
  });
  const scan = scanProject(dir, { trackFunctions: [parseTrackFnSpec('capture')] });
  assert.deepEqual(names(scan), ['bare', 'in_ternary', 'lua_bare']);
});

test('a dotted spec matches that chain, as before', (t) => {
  const dir = makeProject(t, {
    ...JS_SDK,
    'src/a.js': 'Analytics.logEvent("a");\nGame.Analytics.logEvent("b");\nMyAnalytics.logEvent("c");\nlogEvent("d");\n',
  });
  const scan = scanProject(dir, { trackFunctions: [parseTrackFnSpec('Analytics.logEvent')] });
  assert.deepEqual(names(scan), ['a', 'b']);
});

test('a *. spec matches any receiver and never a bare call', (t) => {
  const dir = makeProject(t, {
    ...JS_SDK,
    'src/a.js': 'analytics.capture("a");\nclient?.capture("b");\nthis.client.capture("c");\ncapture("bare");\n',
    'main.lua': 'telemetry:capture("lua")\n',
  });
  const scan = scanProject(dir, { trackFunctions: parseTrackFnFlags(['*.capture']) });
  assert.deepEqual(names(scan), ['a', 'b', 'c', 'lua']);
  assert.ok(scan.inventory.trackCalls.every((c) => c.form === '*.capture'));
});

test('--track-fn *.capture@1 is accepted on the CLI', async (t) => {
  const dir = makeProject(t, { ...JS_SDK, 'src/a.js': 'client.capture(user, "boot");\n' });
  const { code, stdout } = await runCli([dir, '--json', '--track-fn', '*.capture@1']);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout).inventory.eventNames, [{ name: 'boot', count: 1 }]);
  for (const bad of ['*capture', '*.', '**.capture', 'a.*.capture']) {
    assert.throws(() => parseTrackFnSpec(bad), ConfigError, bad);
  }
});

// 3. comments

test('the comments fixture: no commented call is counted in any file type', () => {
  const scan = scanProject(fixture('comments-project'));
  assert.deepEqual(names(scan), [
    'after_blocks',
    'cts_call',
    'menu_clicked',
    'mts_call',
    'regex_kept',
    'svelte_markup_click',
    'svelte_script_call',
    'vue_script_call',
    'vue_template_click',
  ]);
  assert.equal(scan.inventory.unresolvedCalls, 0);
});

test('stripping keeps lines and columns in the new file types', () => {
  const vue = '<template>\n  <!-- x -->\n</template>\n<script setup lang="ts">\n// c\nrs.track("a")\n</script>\n<style>\n/* s */\n</style>\n';
  const out = stripComments(vue, 'a.vue');
  assert.equal(out.length, vue.length);
  assert.equal(out.split('\n').length, vue.split('\n').length);
  assert.equal(out.split('\n')[5], 'rs.track("a")');
  assert.equal(out.split('\n')[0], '<template>');
  const other = '<script lang="coffee">\nrs.track "coffee"\n</script>\n';
  assert.ok(!stripComments(other, 'a.vue').includes('track'));
  const js = 'x = a / b; // rs.track("c")\ny = s.match(/"/) // rs.track("d")\n';
  assert.ok(!stripComments(js, 'a.js').includes('track'));
  // C style languages without regex literals: "/*" after a word opens a block too.
  assert.ok(!stripComments('int n = 1 /* rs.track("a")\nrs.track("b") */;\n', 'a.cs').includes('track'));
});

// 4. two literal ternaries

test('a two literal ternary resolves to both names, listed once', (t) => {
  const dir = makeProject(t, {
    ...JS_SDK,
    'src/a.js': [
      "rs.track(won ? 'playoff_round_cleared' : 'playoff_eliminated');",
      "rs.track(mode === 'a:b' ? \"x?y\" : `plain`);",
      "rs.track(a ? 'one' : b ? 'two' : 'three');",
      "rs.track(a ? 'one' : other);",
      "rs.track(a && 'only');",
      "rs.track(a ? 'level_10' : 'level_11');",
      "rs.track(a ? 'same' : 'same');",
    ].join('\n'),
  });
  const scan = scanProject(dir);
  assert.deepEqual(
    calls(scan).map(([, line, , name, list]) => [line, name, list]),
    [
      [1, null, ['playoff_round_cleared', 'playoff_eliminated']],
      [2, null, ['x?y', 'plain']],
      [3, null, null],
      [4, null, null],
      [5, null, null],
      [6, null, ['level_10', 'level_11']],
      [7, null, ['same']],
    ],
  );
  assert.equal(scan.inventory.unresolvedCalls, 3);
  const counts = Object.fromEntries(scan.inventory.eventNames.map((e) => [e.name, e.count]));
  assert.equal(counts.playoff_round_cleared, 1);
  assert.equal(counts.playoff_eliminated, 1);
  // One cardinality warning for the numbered pair, not one per arm.
  assert.equal(byId(scan.allFindings, 'event_name_cardinality').length, 1);
});

test('paths entries with equally specific matches: the earlier entry wins', (t) => {
  const dir = makeProject(t, {
    ...JS_SDK,
    'ravensight.config.json': JSON.stringify({
      trackFunctions: [
        { name: 'capture', argIndex: 1, paths: ['abc/**'] },
        { name: 'capture', argIndex: 0, paths: ['*.js'] },
      ],
    }),
    'abc/d.js': 'capture(x, "earlier_wins");\n',
  });
  assert.deepEqual(names(scanProject(dir)), ['earlier_wins']);
});

// 0.3.2 review: spaced arrows, path pattern hygiene, the *. suggestion

test('a spaced -> is a lambda or when arrow, not a receiver', () => {
  assert.equal(isQualified('$this->capture(', 7), true);
  assert.equal(isQualified('x -> capture(', 5), false);
  assert.equal(isQualified('true ->capture(', 7), true);
  assert.equal(isQualified('p -> capture(', 5), false);
});

test('Kotlin and Java arrows before a bare call still count', () => {
  const scan = scanProject(fixture('arrow-project'), { trackFunctions: [parseTrackFnSpec('capture')] });
  assert.deepEqual(names(scan), ['java_lambda', 'java_runnable', 'kotlin_lambda', 'kotlin_when_else', 'kotlin_when_true']);
  const any = scanProject(fixture('arrow-project'), { trackFunctions: [parseTrackFnSpec('*.capture')] });
  assert.deepEqual(names(any), ['java_member', 'kotlin_member', 'php_member']);
});

test('paths: a leading ./ is stripped and a backslash is a ConfigError naming the entry', (t) => {
  assert.deepEqual(parseTrackFnSpec({ name: 'capture', paths: ['./server/**', 'dashboard/**'] }).paths, ['server/**', 'dashboard/**']);
  assert.throws(
    () => parseTrackFnSpec({ name: 'capture', paths: ['server\\**'] }),
    (err) => err instanceof ConfigError && /"capture"/.test(err.message) && /backslash/.test(err.message),
  );
  assert.throws(() => parseTrackFnSpec({ name: 'capture', paths: ['./'] }), ConfigError);
  const dir = makeProject(t, {
    ...JS_SDK,
    'ravensight.config.json': JSON.stringify({ trackFunctions: [{ name: 'capture', argIndex: 1, paths: ['./server/**'] }] }),
    'server/a.js': 'capture(user, "dot_slash");\n',
  });
  assert.deepEqual(names(scanProject(dir)), ['dot_slash']);
  const bad = makeProject(t, {
    'ravensight.config.json': JSON.stringify({ trackFunctions: [{ name: 'capture', paths: ['server\\api'] }] }),
  });
  assert.throws(() => loadConfig(bad), /ravensight\.config\.json: Track function "capture": the path pattern/);
});

test('track_fn_unused for a bare name seen only on receivers suggests the *. form', (t) => {
  const dir = makeProject(t, { ...JS_SDK, 'src/a.js': 'analytics.capture("a");\nclient?.capture("b");\n' });
  const unused = byId(scanProject(dir, { trackFunctions: [parseTrackFnSpec('capture')] }).findings, 'track_fn_unused');
  assert.equal(unused.length, 1);
  assert.match(unused[0].detail, /called on a receiver 2 times, which a bare name does not match; use \*\.capture/);
  const never = makeProject(t, { ...JS_SDK, 'src/a.js': 'rs.track("x");\n' });
  const plain = byId(scanProject(never, { trackFunctions: [parseTrackFnSpec('capture')] }).findings, 'track_fn_unused');
  assert.ok(!/\*\.capture/.test(plain[0].detail));
});
