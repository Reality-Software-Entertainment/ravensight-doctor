// 0.4.2: forwarding closures (Swift and JavaScript) and declared forwarders.

import test from 'node:test';
import assert from 'node:assert/strict';
import { scanProject } from '../lib/cli.js';
import { loadConfig, ConfigError } from '../lib/config.js';
import { makeProject, byId } from './helpers.js';

const SWIFT_PKG = { 'Package.swift': '// dependencies: ravensight-swift\n' };
const JS_SDK = { 'package.json': JSON.stringify({ dependencies: { ravensight: '^0.3.0' } }) };

const rows = (scan, file) =>
  scan.inventory.trackCalls.filter((c) => c.file === file).map((c) => [c.line, Boolean(c.forwarded)]);

test('a Swift closure whose parameter is the name argument is a forwarder', (t) => {
  const file = 'Sources/Game/Sink.swift';
  const scan = scanProject(
    makeProject(t, {
      ...SWIFT_PKG,
      [file]: [
        'final class Game {', // 1
        '    var sink: (String, [String: Any]) -> Void = { name, data in Ravensight.track(name, data) }', // 2
        '    func wire(bus: Bus) {', // 3
        '        bus.onEvent { (name: String, data: [String: Any]) in', // 4
        '            Ravensight.track(name, data)', // 5
        '        }', // 6
        '        bus.register(sink: { [weak self] name, data in', // 7
        '            let event = name', // 8
        '            Ravensight.track(event, data)', // 9
        '        })', // 10
        '    }', // 11
        '}', // 12
      ].join('\n'),
    }),
  );
  assert.deepEqual(rows(scan, file), [
    [2, true],
    [5, true],
    [9, false],
  ]);
  assert.equal(scan.inventory.trackCalls.find((c) => c.line === 2).via, 'closure');
});

test('a JS closure assigned to a property or passed as a sink is a forwarder', (t) => {
  const file = 'src/bridge.js';
  const scan = scanProject(
    makeProject(t, {
      ...JS_SDK,
      [file]: [
        'bridge.send = (name, data) => rs.track(name, data)', // 1
        'register((name, data) => rs.track(name, data))', // 2
        'const handlers = { emit: function (name, data) { rs.track(name, data) } }', // 3
      ].join('\n'),
    }),
  );
  assert.deepEqual(rows(scan, file), [
    [1, true],
    [2, true],
    [3, true],
  ]);
  assert.deepEqual(byId(scan.allFindings, 'tracking_unresolved'), []);
});

test('negative: an iteration callback, a non parameter name and an outer parameter stay unresolved', (t) => {
  const file = 'src/loops.js';
  const scan = scanProject(
    makeProject(t, {
      ...JS_SDK,
      [file]: [
        'items.forEach((n) => rs.track(n))', // 1
        'names.map(function (n) { return rs.track(n) })', // 2
        'bridge.send = (data) => rs.track(current, data)', // 3
        'bridge.flush = (name) => { list.forEach((x) => rs.track(x)) }', // 4
      ].join('\n'),
    }),
  );
  assert.deepEqual(rows(scan, file), [
    [1, false],
    [2, false],
    [3, false],
    [4, false],
  ]);
  const swift = 'Sources/Game/Loop.swift';
  const scan2 = scanProject(
    makeProject(t, {
      ...SWIFT_PKG,
      [swift]: 'func replay(names: [String]) {\n    names.forEach { name in Ravensight.track(name) }\n    send = { Ravensight.track($0, $1) }\n}\n',
    }),
  );
  assert.deepEqual(rows(scan2, swift), [
    [2, false],
    [3, false],
  ]);
});

test('forwarders names a sink the heuristic cannot see, and nothing else', (t) => {
  const file = 'Sources/Game/TelemetrySink.swift';
  const scan = scanProject(
    makeProject(t, {
      ...SWIFT_PKG,
      'ravensight.config.json': JSON.stringify({ forwarders: ['TelemetrySink.send', 'Missing.thing'] }),
      [file]: [
        'enum TelemetrySink {', // 1
        '    static var send: (String, [String: Any]) -> Void = {', // 2
        '        Ravensight.track($0, $1)', // 3
        '    }', // 4
        '}', // 5
        'func other() {', // 6
        '    Ravensight.track(pending.name)', // 7
        '}', // 8
        'TelemetrySink.send("level_start", [:])', // 9
      ].join('\n'),
    }),
  );
  assert.deepEqual(rows(scan, file), [
    [3, true],
    [7, false],
  ]);
  assert.equal(scan.inventory.trackCalls[0].via, 'forwarders: TelemetrySink.send');
  const [unmatched, ...more] = byId(scan.allFindings, 'forwarder_unmatched');
  assert.equal(more.length, 0);
  assert.equal(unmatched.severity, 'info');
  assert.match(unmatched.detail, /Missing\.thing/);
});

test('a dotted forwarder needs its owner in the file; a JS function forwarder works by name', (t) => {
  const scan = scanProject(
    makeProject(t, {
      ...JS_SDK,
      'ravensight.config.json': JSON.stringify({ forwarders: ['Sink.send', 'relay'] }),
      'src/a.js': 'function send(e) {\n  rs.track(e.n)\n}\nfunction relay(args) {\n  rs.track(args[0])\n}\n',
    }),
  );
  assert.deepEqual(rows(scan, 'src/a.js'), [
    [2, false],
    [5, true],
  ]);
});

test('forwarders is validated', (t) => {
  for (const bad of ['"send"', '["*.send"]', '["a:b"]', '[1]']) {
    const dir = makeProject(t, { 'ravensight.config.json': `{"forwarders": ${bad}}` });
    assert.throws(() => loadConfig(dir), ConfigError, bad);
  }
});
