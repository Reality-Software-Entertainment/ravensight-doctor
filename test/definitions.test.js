// 0.4.2: definitions, interface and type signatures, and abstract methods
// are never calls.

import test from 'node:test';
import assert from 'node:assert/strict';
import { scanProject } from '../lib/cli.js';
import { isDefinition } from '../lib/checks.js';
import { makeProject, byId } from './helpers.js';

const JS_SDK = { 'package.json': JSON.stringify({ dependencies: { ravensight: '^0.3.0' } }) };

function scan(t, file, source, trackFunctions = ['capture']) {
  return scanProject(
    makeProject(t, { ...JS_SDK, 'ravensight.config.json': JSON.stringify({ trackFunctions }), [file]: source }),
  );
}

const calls = (s) => s.inventory.trackCalls.filter((c) => c.form === 'capture').map((c) => [c.line, c.name]);

test('an interface method signature is not a call, and a real call on the next line is', (t) => {
  const s = scan(t, 'src/tracker.ts', [
    'interface Tracker {', // 1
    '  capture(event: string): void;', // 2
    '  capture(event: string, data?: Record<string, unknown>): Promise<void>', // 3
    '  capture(event: string);', // 4
    '}', // 5
    "capture('level_start')", // 6
  ].join('\n'));
  assert.deepEqual(calls(s), [[6, 'level_start']]);
  assert.deepEqual(byId(s.allFindings, 'tracking_unresolved'), []);
});

test('a type literal method signature is not a call', (t) => {
  const s = scan(t, 'src/types.ts', "type Sink = { capture(event: string): void }\ncapture('boot')\n");
  assert.deepEqual(calls(s), [[2, 'boot']]);
});

test('an abstract method is not a call', (t) => {
  const s = scan(t, 'src/base.ts', [
    'export abstract class Base {', // 1
    '  abstract capture(event: string): void;', // 2
    '  protected abstract capture(event: string, props: object): void', // 3
    '}', // 4
    "capture('menu_open')", // 5
  ].join('\n'));
  assert.deepEqual(calls(s), [[5, 'menu_open']]);
});

test('a class method definition and a function definition are not calls', (t) => {
  const s = scan(t, 'src/impl.js', [
    'class Impl {', // 1
    '  capture(event, data) {', // 2
    '    rs.track(event, data)', // 3
    '  }', // 4
    '}', // 5
    'function capture(event) {', // 6
    '  rs.track(event)', // 7
    '}', // 8
    "capture('shop_open')", // 9
  ].join('\n'));
  assert.deepEqual(calls(s), [[9, 'shop_open']]);
  assert.equal(s.inventory.unresolvedCalls, 0);
});

test('an arrow assignment definition is not a call', (t) => {
  const s = scan(t, 'src/arrow.ts', [
    'const capture = (event: string): void => rs.track(event)', // 1
    "capture('quest_open')", // 2
  ].join('\n'));
  assert.deepEqual(calls(s), [[2, 'quest_open']]);
  assert.equal(s.inventory.unresolvedCalls, 0);
});

test('a signature outside an entry\'s paths is not reported as a call outside paths', (t) => {
  const s = scan(t, 'shared/tracker.ts', 'export interface Tracker {\n  capture(event: string): void;\n}\n', [
    { name: 'capture', paths: ['server/**'] },
  ]);
  assert.deepEqual(byId(s.allFindings, 'calls_outside_paths'), []);
});

test('isDefinition keeps calls that look close to a signature', () => {
  const at = (line, ext = 'ts') => {
    const start = line.indexOf('capture(');
    return isDefinition(line, start, start + 'capture'.length, ext);
  };
  assert.equal(at('capture(event: string): void;'), true);
  assert.equal(at('capture(event);'), false);
  assert.equal(at('capture(a ? b : c);'), false);
  assert.equal(at("capture('x') ? a : b"), false);
  assert.equal(at('const r = capture(e): void'), false);
  assert.equal(at('capture(name: "x")', 'swift'), false);
  assert.equal(at('capture(x):next()', 'lua'), false);
});
