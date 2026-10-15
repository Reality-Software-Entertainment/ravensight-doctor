// 0.4.1: a wrapper that forwards its name inside an object literal, or that
// queues call objects flushed later, still counts as forwarded.

import test from 'node:test';
import assert from 'node:assert/strict';
import { scanProject } from '../lib/cli.js';
import { nameProperties } from '../lib/wrappers.js';
import { makeProject } from './helpers.js';

const cfg = (extra = {}) => JSON.stringify({ trackFunctions: ['logEvent', '*.capture'], ...extra });
const scanOf = (t, src) => scanProject(makeProject(t, { 'a.js': src, 'ravensight.config.json': cfg() }));
const unresolvedLines = (scan) =>
  scan.inventory.trackCalls.filter((c) => c.name === null && !c.names && !c.forwarded).map((c) => c.line);

test('nameProperties reads event, name and event_name and the shorthand', () => {
  assert.deepEqual(nameProperties('{ event: name, properties }'), [{ key: 'event', value: 'name' }]);
  assert.deepEqual(nameProperties('{ event, props }'), [{ key: 'event', value: 'event' }]);
  assert.deepEqual(nameProperties("{ 'event_name': n, name: 'x', other: n }"), [
    { key: 'event_name', value: 'n' },
    { key: 'name', value: '' },
  ]);
  assert.deepEqual(nameProperties('not an object'), []);
});

test('an object literal naming the wrapper parameter is forwarded', (t) => {
  const scan = scanOf(t, [
    'function logEvent(name, properties) {', // 1
    '  vendor.capture({ event: name, properties });', // 2
    '  vendor.capture({ name, properties });', // 3
    '  const event = name.trim();', // 4
    '  vendor.capture({ event });', // 5
    '  vendor.capture({', // 6
    '    event_name: name,', // 7
    '    properties,', // 8
    '  });', // 9
    '}',
  ].join('\n'));
  assert.deepEqual(unresolvedLines(scan), []);
  assert.equal(scan.inventory.forwardedCalls, 4);
});

test('object literals that do not carry the parameter stay unresolved', (t) => {
  const scan = scanOf(t, [
    'function logEvent(name, properties) {', // 1
    "  vendor.capture({ event: 'level_start', properties });", // 2
    '  vendor.capture({ event: other, properties });', // 3
    '  vendor.capture({ distinct_id: name });', // 4
    '}',
    'function elsewhere(name) {', // 6
    '  vendor.capture({ event: name });', // 7
    '}',
    'vendor.capture({ event: name });', // 9
  ].join('\n'));
  assert.deepEqual(unresolvedLines(scan), [2, 3, 4, 7, 9]);
});

const QUEUE = [
  'const queue = [];', // 1
  'function logEvent(name, props) {', // 2
  '  queue.push({ event: name, props });', // 3
  '}', // 4
  'function flush(client) {', // 5
  '  for (const call of queue) client.capture(call.event, call.props);', // 6
  '  for (const call of queue) {', // 7
  "    client.capture(call['event'], call.props);", // 8
  '  }', // 9
  '  queue.forEach((c) => client.capture(c.event, c.props));', // 10
  '  for (const { event, props } of queue) client.capture(event, props);', // 11
  '}',
].join('\n');

test('a member of a loop variable over a queue the wrapper fills is forwarded', (t) => {
  const scan = scanOf(t, QUEUE);
  assert.deepEqual(unresolvedLines(scan), []);
  assert.equal(scan.inventory.forwardedCalls, 4);
});

test('a queue not filled from the name parameter stays unresolved', (t) => {
  const scan = scanOf(t, [
    'const queue = [];',
    'const other = [];',
    'function logEvent(name, props) {',
    '  queue.push({ event: name, props });',
    "  other.push({ event: 'fixed', props });",
    '}',
    'function flush(client) {',
    '  for (const call of other) client.capture(call.event, call.props);', // 8
    '  for (const call of queue) client.capture(call.kind, call.props);', // 9
    '  for (const call of elsewhere) client.capture(call.event, call.props);', // 10
    '  client.capture(call.event, call.props);', // 11
    '}',
    'queue.push({ event: name });', // 13: outside a wrapper
    'for (const call of queue) client.capture(call.event);', // 14 still resolved by the wrapper push
  ].join('\n'));
  assert.deepEqual(unresolvedLines(scan), [8, 9, 10, 11]);
});

test('a queue pushed to outside any wrapper is not followed', (t) => {
  const scan = scanOf(t, [
    'const queue = [];',
    'function helper(name) {',
    '  queue.push({ event: name });',
    '}',
    'for (const call of queue) client.capture(call.event);', // 5
  ].join('\n'));
  assert.deepEqual(unresolvedLines(scan), [5]);
});
