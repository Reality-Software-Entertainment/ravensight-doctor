// 0.4.0: ignoreCalls, and a wrapper's forwarding call outside the entry's
// paths counts as forwarded.

import test from 'node:test';
import assert from 'node:assert/strict';
import { scanProject } from '../lib/cli.js';
import { loadConfig, ConfigError } from '../lib/config.js';
import { makeProject, byId, runCli } from './helpers.js';

const WRAPPERS = [
  'import rs from "ravensight";', // 1
  'export function sendA(name, props) {', // 2
  '  rs.track(name, props);', // 3
  '  vendor.capture(name, props);', // 4
  '}', // 5
  'export const sendB = (name, props) => {', // 6
  '  rs.track(name, props);', // 7
  '  client.capture(name, props);', // 8
  '};', // 9
].join('\n');

const config = (obj) => JSON.stringify(obj);

test('ignoreCalls leaves matching calls out of the inventory and counts them', (t) => {
  const dir = makeProject(t, {
    'lib/wrappers.js': WRAPPERS + '\nvendor.capture(someVar, {});\nclient.capture("x", {});\n',
    'ravensight.config.json': config({
      trackFunctions: ['sendA', 'sendB', { name: '*.capture', paths: ['src/**'] }],
      ignoreCalls: ['vendor.capture', 'client.capture'],
    }),
  });
  const scan = scanProject(dir, { ignoreCalls: [] });
  assert.equal(scan.inventory.ignoredCalls, 4);
  assert.equal(scan.inventory.callsOutsidePaths, 0);
  assert.equal(scan.inventory.trackCalls.filter((c) => /capture/.test(c.form)).length, 0);
  assert.deepEqual(byId(scan.allFindings, 'calls_outside_paths'), []);
  assert.deepEqual(byId(scan.allFindings, 'tracking_unresolved'), []);
});

test('ignoreCalls accepts a *.capture style entry and keeps unrelated calls unresolved', (t) => {
  const dir = makeProject(t, {
    'src/a.js': 'vendor.capture(a, {});\nother.send(b, {});\nthing.capture(c, {});\n',
    'ravensight.config.json': config({ trackFunctions: ['*.capture', '*.send'], ignoreCalls: ['*.capture'] }),
  });
  const scan = scanProject(dir);
  assert.equal(scan.inventory.ignoredCalls, 2);
  const [f] = byId(scan.allFindings, 'tracking_unresolved');
  assert.equal(f.line, 2);
  assert.equal(scan.inventory.unresolvedCalls, 1);
});

test('an exact ignoreCalls receiver does not ignore another receiver', (t) => {
  const dir = makeProject(t, {
    'src/a.js': 'vendor.capture(a, {});\nclient.capture(b, {});\n',
    'ravensight.config.json': config({ trackFunctions: ['*.capture'], ignoreCalls: ['vendor.capture'] }),
  });
  const scan = scanProject(dir);
  assert.equal(scan.inventory.ignoredCalls, 1);
  assert.equal(byId(scan.allFindings, 'tracking_unresolved')[0].line, 2);
});

test('ignoreCalls is validated', (t) => {
  const bad = makeProject(t, { 'ravensight.config.json': config({ ignoreCalls: 'vendor.capture' }) });
  assert.throws(() => loadConfig(bad), ConfigError);
  const badName = makeProject(t, { 'ravensight.config.json': config({ ignoreCalls: ['a b'] }) });
  assert.throws(() => loadConfig(badName), /ignoreCalls\[0\]/);
  const ok = makeProject(t, { 'ravensight.config.json': config({ ignoreCalls: ['vendor.capture'] }) });
  const c = loadConfig(ok);
  assert.deepEqual(c.ignoreCalls, ['vendor.capture']);
  assert.deepEqual(c.unknownKeys, []);
});

test('the pretty report prints the ignored calls line', async (t) => {
  const dir = makeProject(t, {
    'src/a.js': 'vendor.capture(a, {});\n',
    'ravensight.config.json': config({ trackFunctions: ['*.capture'], ignoreCalls: ['vendor.capture'] }),
  });
  const { stdout } = await runCli([dir]);
  assert.match(stdout, /Ignored calls: 1 \(ignoreCalls\)/);
  const { stdout: json } = await runCli([dir, '--json']);
  assert.equal(JSON.parse(json).inventory.ignoredCalls, 1);
});

test('a call forwarding the wrapper parameter is forwarded even outside the entry paths', (t) => {
  const dir = makeProject(t, {
    'lib/wrappers.js': WRAPPERS,
    'src/b.js': 'export function other(x) { vendor.capture(x, {}); }\n',
    'ravensight.config.json': config({
      trackFunctions: ['sendA', 'sendB', { name: '*.capture', paths: ['src/**'] }],
    }),
  });
  const scan = scanProject(dir);
  assert.equal(scan.inventory.callsOutsidePaths, 0);
  assert.equal(scan.inventory.forwardedCalls, 4);
  assert.equal(scan.inventory.ignoredCalls, 0);
  // The unrelated call in src/ is still unresolved.
  const [f] = byId(scan.allFindings, 'tracking_unresolved');
  assert.equal(f.file, 'src/b.js');
});

test('outside the paths and not forwarding stays an outside-paths finding', (t) => {
  const dir = makeProject(t, {
    'lib/wrappers.js': WRAPPERS + 'vendor.capture(other, {});\n',
    'ravensight.config.json': config({ trackFunctions: ['sendA', 'sendB', { name: '*.capture', paths: ['src/**'] }] }),
  });
  const scan = scanProject(dir);
  assert.equal(scan.inventory.callsOutsidePaths, 1);
});
