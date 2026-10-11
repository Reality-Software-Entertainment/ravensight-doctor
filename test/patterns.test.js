import test from 'node:test';
import assert from 'node:assert/strict';
import { scanProject } from '../lib/cli.js';
import { buildReport, toSubmission, formatPretty } from '../lib/report.js';
import { parseTrackFnSpec, parseTrackFnFlags, ConfigError } from '../lib/config.js';
import { makeProject, ids, byId } from './helpers.js';

export const KEY = 'gt_live_' + 'Ab3xY9Qz'.repeat(4); // 32 chars, fake

const JS_SDK = { 'package.json': JSON.stringify({ dependencies: { ravensight: '^0.3.0' } }) };
const GD_SDK = {
  'project.godot': 'config_version=5\n',
  'addons/ravensight/Ravensight.gd': 'extends Node\nfunc track(n, d := {}):\n\treturn true\n',
};

function report(scan) {
  return buildReport(scan.engine, scan.findings, scan.totals, '0.2.0', { inventory: scan.inventory });
}

function wrapperProject(t, extra = {}) {
  return makeProject(t, {
    ...JS_SDK,
    'src/analytics.js':
      `const rs = new Ravensight({ ingestKey: "${KEY}" });\n` +
      'export function logEvent(name, data) {\n  rs.track(name, data);\n}\n',
    'src/game.js': 'logEvent("level_completed", { level: 1 });\nlogEvent("run_won");\nlogEvent("level_completed");\n',
    ...extra,
  });
}

test('a wrapper with only variable names is inconclusive, never healthy', (t) => {
  const scan = scanProject(wrapperProject(t));
  const unv = byId(scan.findings, 'tracking_unverified');
  assert.equal(unv.length, 1);
  assert.equal(unv[0].severity, 'warning');
  assert.match(unv[0].detail, /--track-fn/);
  const rep = report(scan);
  assert.equal(rep.summary.status, 'inconclusive');
  assert.equal(scan.inventory.trackCalls.length, 1);
  assert.equal(scan.inventory.unresolvedCalls, 1);
  assert.deepEqual(scan.inventory.eventNames, []);
  const pretty = formatPretty(rep, {});
  assert.ok(!pretty.includes('looks healthy'));
  assert.ok(pretty.includes('Inventory'));
  assert.ok(pretty.includes('Status:  inconclusive'));
});

test('naming the wrapper resolves it: names counted, definition not counted', (t) => {
  const scan = scanProject(wrapperProject(t), { trackFunctions: [parseTrackFnSpec('logEvent')] });
  assert.equal(byId(scan.findings, 'tracking_unverified').length, 0);
  assert.deepEqual(scan.inventory.eventNames, [
    { name: 'level_completed', count: 2 },
    { name: 'run_won', count: 1 },
  ]);
  assert.equal(scan.inventory.trackCalls.length, 4); // 3 wrapper calls + rs.track(name)
  // rs.track(name) inside logEvent forwards the wrapper's own parameter.
  assert.equal(scan.inventory.unresolvedCalls, 0);
  assert.equal(scan.inventory.forwardedCalls, 1);
  assert.equal(byId(scan.findings, 'tracking_unresolved').length, 0);
  const call = scan.inventory.trackCalls.find((c) => c.file === 'src/game.js' && c.line === 2);
  assert.deepEqual(call, { file: 'src/game.js', line: 2, form: 'logEvent', name: 'run_won' });
  const rep = report(scan);
  assert.equal(rep.summary.status, 'pass');
  assert.ok(formatPretty(rep, {}).includes('looks healthy'));
});

test('member chains: the identifier before .track( must be rs, ravensight or Ravensight', (t) => {
  const dir = makeProject(t, {
    ...JS_SDK,
    'src/a.js': [
      'this.rs.track("chain_this");',
      'window.rs.track("chain_window");',
      'game.ravensight.track("chain_lower");',
      'App.Ravensight.track("chain_upper");',
      'analytics.track("not_ours");',
      'myrs.track("not_ours_either");',
      'rs.tracker("nope");',
    ].join('\n'),
  });
  const names = scanProject(dir).inventory.eventNames.map((e) => e.name).sort();
  assert.deepEqual(names, ['chain_lower', 'chain_this', 'chain_upper', 'chain_window']);
});

test('two calls on one line are both recorded', (t) => {
  const dir = makeProject(t, { ...JS_SDK, 'src/a.js': 'rs.track("a"); rs.track("b");\n' });
  assert.deepEqual(scanProject(dir).inventory.eventNames.map((e) => e.name), ['a', 'b']);
});

test('a dotted spec anchors the last receiver segment', (t) => {
  const dir = makeProject(t, {
    ...JS_SDK,
    'src/a.js': [
      'Analytics.logEvent("direct");',
      'Game.Analytics.logEvent("chained");',
      'MyAnalytics.logEvent("other_receiver");',
      'logEvent("bare");',
    ].join('\n'),
  });
  const scan = scanProject(dir, { trackFunctions: [parseTrackFnSpec('Analytics.logEvent')] });
  assert.deepEqual(scan.inventory.eventNames.map((e) => e.name).sort(), ['chained', 'direct']);
  assert.equal(scan.inventory.trackCalls[0].form, 'Analytics.logEvent');
});

test('argIndex reads the event name from a later argument', (t) => {
  const dir = makeProject(t, {
    ...GD_SDK,
    'ravensight.config.json': JSON.stringify({ trackFunctions: [{ name: 'track_event', argIndex: 1 }] }),
    'scripts/boss.gd': 'extends Node\nfunc track_event(who, name):\n\tpass\nfunc die():\n\ttrack_event(self, "boss_down")\n',
  });
  const scan = scanProject(dir);
  assert.deepEqual(scan.inventory.eventNames, [{ name: 'boss_down', count: 1 }]);
  const fn = scan.inventory.trackFunctions.find((f) => f.name === 'track_event');
  assert.deepEqual(fn, { name: 'track_event', argIndex: 1, source: 'config', calls: 1 });
});

test('an unused custom track function is an info finding', (t) => {
  const dir = makeProject(t, {
    ...GD_SDK,
    'ravensight.config.json': JSON.stringify({ trackFunctions: ['capture'] }),
    'main.gd': 'extends Node\nfunc go():\n\tRavensight.track("boot")\n',
  });
  const unused = byId(scanProject(dir).findings, 'track_fn_unused');
  assert.equal(unused.length, 1);
  assert.equal(unused[0].severity, 'info');
  assert.match(unused[0].detail, /capture/);
});

test('clause B: a real key with no recognised calls is inconclusive and hides no_track_calls', (t) => {
  const dir = makeProject(t, {
    ...GD_SDK,
    'scripts/setup.gd': `extends Node\nfunc _ready():\n\tRavensight.ingest_key = "${KEY}"\n\tMyWrapper.send("boot")\n`,
  });
  const scan = scanProject(dir);
  assert.equal(byId(scan.findings, 'tracking_unverified').length, 1);
  assert.ok(!ids(scan.findings).includes('no_track_calls'));
  assert.equal(report(scan).summary.status, 'inconclusive');
});

test('no key and no calls keeps the old no_track_calls info', (t) => {
  const scan = scanProject(makeProject(t, GD_SDK));
  assert.ok(ids(scan.findings).includes('no_track_calls'));
  assert.ok(!ids(scan.findings).includes('tracking_unverified'));
});

test('status precedence: fail beats inconclusive beats warn', () => {
  const unv = { id: 'tracking_unverified', severity: 'warning', title: 't', detail: 'd' };
  const warn = { id: 'event_name_cardinality', severity: 'warning', title: 't', detail: 'd' };
  const err = { id: 'sdk_missing', severity: 'error', title: 't', detail: 'd' };
  const st = (fs) =>
    buildReport('godot', fs, { errors: fs.filter((f) => f.severity === 'error').length, warnings: fs.filter((f) => f.severity === 'warning').length }, '0.2.0').summary.status;
  assert.equal(st([err, unv, warn]), 'fail');
  assert.equal(st([unv, warn]), 'inconclusive');
  assert.equal(st([warn]), 'warn');
  assert.equal(st([]), 'pass');
});

test('toSubmission maps inconclusive to warn and strips inventory and live', () => {
  const rep = buildReport(
    'godot',
    [{ id: 'tracking_unverified', severity: 'warning', title: 't', detail: 'd' }],
    { errors: 0, warnings: 1 },
    '0.2.0',
    { inventory: { trackCalls: [] }, live: { ok: true } },
  );
  const sub = toSubmission(rep);
  assert.equal(sub.summary.status, 'warn');
  assert.ok(!('inventory' in sub));
  assert.ok(!('live' in sub));
  assert.deepEqual(Object.keys(sub).sort(), ['doctorVersion', 'engine', 'findings', 'summary']);
});

test('parseTrackFnSpec accepts names, dotted names and objects, rejects the rest', () => {
  assert.deepEqual(parseTrackFnSpec('capture'), { name: 'capture', argIndex: 0, source: 'flag' });
  assert.deepEqual(parseTrackFnSpec({ name: 'A.b', argIndex: 2 }, 'config'), { name: 'A.b', argIndex: 2, source: 'config' });
  for (const bad of ['1bad', 'a..b', 'a b', '', 'a(', { name: 'x', argIndex: -1 }, { name: 'x', argIndex: 1.5 }, { argIndex: 1 }, 42]) {
    assert.throws(() => parseTrackFnSpec(bad), ConfigError, JSON.stringify(bad));
  }
  assert.deepEqual(parseTrackFnSpec({ name: 'x', extra: 1 }, 'config'), { name: 'x', argIndex: 0, source: 'config' });
  assert.deepEqual(parseTrackFnFlags(['capture,Analytics.logEvent', 'track_event']).map((s) => s.name), [
    'capture',
    'Analytics.logEvent',
    'track_event',
  ]);
});

test('JSON inventory shape', (t) => {
  const scan = scanProject(wrapperProject(t), { trackFunctions: [parseTrackFnSpec('logEvent')] });
  const inv = scan.inventory;
  assert.deepEqual(Object.keys(inv).sort(), [
    'eventNames',
    'filesLeftOutOfCallScan',
    'filesScannedForCalls',
    'filesScannedForKeys',
    'forwardedCalls',
    'ingestKeys',
    'trackCalls',
    'trackFunctions',
    'unresolvedCalls',
  ]);
  assert.equal(inv.filesScannedForCalls, 3);
  assert.equal(inv.filesScannedForKeys, 3);
  assert.deepEqual(inv.ingestKeys, { live: 1, test: 0 });
  for (const c of inv.trackCalls) {
    assert.equal(typeof c.file, 'string');
    assert.equal(typeof c.line, 'number');
    assert.equal(typeof c.form, 'string');
    assert.ok(c.name === null || typeof c.name === 'string');
  }
  assert.ok(inv.trackFunctions.some((f) => f.name === 'rs.track' && f.source === 'builtin' && f.calls === 1));
  assert.ok(inv.trackFunctions.some((f) => f.name === 'logEvent' && f.source === 'flag' && f.calls === 3));
});
