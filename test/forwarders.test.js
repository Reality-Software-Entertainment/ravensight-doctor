// 0.4.0: Swift forwarding wrappers and labelled arguments, and the LÖVE
// bridge forms a named handler and a local assigned in a try block.

import test from 'node:test';
import assert from 'node:assert/strict';
import { scanProject } from '../lib/cli.js';
import { swiftParams } from '../lib/wrappers.js';
import { makeProject, byId, runCli } from './helpers.js';

const ANALYTICS_SWIFT = [
  'import Ravensight', // 1
  '', // 2
  'enum Analytics {', // 3
  '    static var sent = Set<String>()', // 4
  '', // 5
  '    static func emit(_ name: String, _ props: [String: Any] = [:]) {', // 6
  '        Ravensight.track(name, props)', // 7
  '    }', // 8
  '', // 9
  '    static func emitOnce(key: String, _ name: String, props: [String: Any] = [:]) {', // 10
  '        guard !sent.contains(key) else { return }', // 11
  '        sent.insert(key)', // 12
  '        emit(name, props)', // 13
  '    }', // 14
  '}', // 15
  '', // 16
  'func play() {', // 17
  '    Analytics.emit("run_started", ["run_id": "r1"])', // 18
  '    Analytics.emitOnce(key: "intro", "progress_unlocked", props: ["content_id": "intro"])', // 19
  '    Analytics.emitOnce(key: "credits", name: "ending_seen")', // 20
  '}', // 21
].join('\n');

test('swiftParams gives labels and internal names in order', () => {
  assert.deepEqual(swiftParams('key: String, _ name: String, with props: [String: Any] = [:]'), [
    { label: 'key', name: 'key' },
    { label: '_', name: 'name' },
    { label: 'with', name: 'props' },
  ]);
});

test('a Swift call forwarding a parameter suggests the enclosing function as a track wrapper', (t) => {
  const dir = makeProject(t, { 'Sources/Analytics.swift': ANALYTICS_SWIFT });
  const scan = scanProject(dir, { trackFunctions: [{ name: '*.emit', argIndex: 0, source: 'flag' }, { name: 'emit', argIndex: 0, source: 'flag' }] });
  const [f] = byId(scan.allFindings, 'tracking_unresolved');
  assert.equal(f.line, 13);
  assert.match(f.detail, /forwards the parameter name of emitOnce, argument 1/);
  assert.match(f.detail, /--track-fn '\*\.emitOnce@1'/);
  assert.match(f.detail, /'emitOnce@1' as well for bare calls/);
  const call = scan.inventory.trackCalls.find((c) => c.line === 13);
  assert.equal(call.suggestTrackFn, '*.emitOnce@1');
});

test('with both wrappers named, the forwarding call resolves and labelled names are read', (t) => {
  const dir = makeProject(t, { 'Sources/Analytics.swift': ANALYTICS_SWIFT });
  const flag = (name, argIndex) => ({ name, argIndex, source: 'flag' });
  const scan = scanProject(dir, { trackFunctions: [flag('*.emit', 0), flag('emit', 0), flag('*.emitOnce', 1)] });
  assert.deepEqual(byId(scan.allFindings, 'tracking_unresolved'), []);
  assert.deepEqual(
    scan.inventory.eventNames.map((e) => e.name).sort(),
    ['ending_seen', 'progress_unlocked', 'run_started'],
  );
  assert.equal(scan.inventory.trackCalls.find((c) => c.line === 13).forwarded, true);
});

test('a top level Swift function gets the bare form, and other languages get the generic hint', (t) => {
  const dir = makeProject(t, {
    'Sources/Log.swift': 'func logEvent(_ event: String) {\n    Ravensight.track(event)\n}\n',
    'src/a.js': 'function logEvent(e) {\n  rs.track(e)\n}\n',
  });
  const [f] = byId(scanProject(dir).allFindings, 'tracking_unresolved');
  assert.match(f.detail, /--track-fn 'logEvent'/);
  assert.ok(!f.detail.includes("as well for bare calls"));
  const js = makeProject(t, { 'src/a.js': 'function logEvent(e) {\n  rs.track(e)\n}\n' });
  const [g] = byId(scanProject(js).allFindings, 'tracking_unresolved');
  assert.match(g.detail, /name it with --track-fn <name>/);
});

test('the CLI prints the Swift suggestion', async (t) => {
  const dir = makeProject(t, { 'Sources/Analytics.swift': ANALYTICS_SWIFT });
  const r = await runCli([dir, '--track-fn', '*.emit,emit']);
  assert.match(r.stdout, /emitOnce is a track wrapper too/);
});

// LÖVE bridge handlers in an HTML page

function bridge(t, body) {
  const page = ['<!doctype html>', '<html><body>', '<script>', ...body, '</script>', '</body></html>'].join('\n');
  const dir = makeProject(t, { 'web/index.html': page + '\n' });
  const scan = scanProject(dir, { trackFunctions: [{ name: '*.track', argIndex: 0, source: 'flag' }] });
  return scan.inventory.trackCalls.map((c) => Boolean(c.forwarded));
}

test('a named handler assigned later with let m; try { m = JSON.parse(text) } forwards', (t) => {
  assert.deepEqual(
    bridge(t, [
      'function handle(text) {',
      '  let m;',
      '  try { m = JSON.parse(text) } catch (e) { return }',
      '  c.track(m.name, m.data);',
      '}',
      'Module.print = handle;',
    ]),
    [true],
  );
});

test('a named handler assigned later with const m = parseLine(text) forwards', (t) => {
  assert.deepEqual(
    bridge(t, [
      'function handle(text) {',
      '  const m = parseLine(text);',
      '  c.track(m.name, m.data);',
      '}',
      'window.__rsBridge = handle;',
    ]),
    [true],
  );
});

test('an inline named handler with let m; try forwards', (t) => {
  assert.deepEqual(
    bridge(t, [
      'window.__rsBridge = function handle(text) {',
      '  let m;',
      '  try { m = JSON.parse(text) } catch (e) { return }',
      '  c.track(m.name, m.data);',
      '};',
    ]),
    [true],
  );
});

test('an inline named handler with const forwards', (t) => {
  assert.deepEqual(
    bridge(t, [
      'window.__rsBridge = function handle(text) {',
      '  const m = parseLine(text);',
      '  c.track(m.name, m.data);',
      '};',
    ]),
    [true],
  );
});

test('a later reassignment from a literal, or a named function never assigned, stays unresolved', (t) => {
  assert.deepEqual(
    bridge(t, [
      'function handle(text) {',
      '  let m;',
      '  try { m = JSON.parse(text) } catch (e) { m = { name: "fallback" } }',
      '  c.track(m.name, m.data);',
      '}',
      'Module.print = handle;',
      'function helper(text) {',
      '  const m = JSON.parse(text);',
      '  c.track(m.name);',
      '}',
      'function other(text) {',
      '  let m;',
      '  m = { name: "x" };',
      '  c.track(m.name);',
      '}',
      'Module.printErr = other;',
    ]),
    [false, false, false],
  );
});
