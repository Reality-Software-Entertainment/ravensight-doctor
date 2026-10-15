// 0.4.2: name_without_kind.

import test from 'node:test';
import assert from 'node:assert/strict';
import { scanProject } from '../lib/cli.js';
import { kindByName } from '../lib/kinds.js';
import { loadConfig, ConfigError } from '../lib/config.js';
import { makeProject, byId } from './helpers.js';

const JS_SDK = { 'package.json': JSON.stringify({ dependencies: { ravensight: '^0.3.0' } }) };
// A project that chose to carry rs_kind on every level event.
const EXPLICIT = { 'ravensight.config.json': JSON.stringify({ kinds: 'explicit' }) };

const warned = (scan) => byId(scan.allFindings, 'name_without_kind').map((f) => [f.line, f.severity]);

test('kindByName follows the platform patterns, case sensitive', () => {
  assert.equal(kindByName('checkout_started').kind, 'level_start');
  assert.equal(kindByName('entered_shop').word, 'enter');
  assert.equal(kindByName('level_completed').kind, 'level_complete');
  assert.equal(kindByName('window_opened').word, 'win');
  assert.equal(kindByName('boss_killed').kind, 'death');
  assert.equal(kindByName('Start_menu'), null);
  assert.equal(kindByName('menu_opened'), null);
});

test('a kind word without rs_kind warns; rs_kind, none, unreadable props and other names do not', (t) => {
  const scan = scanProject(
    makeProject(t, {
      ...JS_SDK,
      ...EXPLICIT,
      'src/a.js': [
        "rs.track('checkout_started', { cart: 3 })", // 1 warns
        "rs.track('level_start')", // 2 warns: no props at all
        "rs.track('level_start', { rs_kind: 'level_start' })", // 3
        "rs.track('checkout_started', { rs_kind: 'none' })", // 4
        "rs.track('boss_killed', props)", // 5 unreadable
        "rs.track('menu_opened', { a: 1 })", // 6 no kind word
        "rs.track(won ? 'run_finished' : 'run_lost', { seed })", // 7 warns: a ternary arm
      ].join('\n'),
    }),
  );
  assert.deepEqual(warned(scan), [
    [1, 'warning'],
    [2, 'warning'],
    [7, 'warning'],
  ]);
  const [first] = byId(scan.allFindings, 'name_without_kind');
  assert.match(first.title, /add rs_kind, or none to opt out/);
  assert.match(first.detail, /contains "start"/);
});

test('a wrapper whose enriches lists rs_kind is skipped; one without it still warns', (t) => {
  const files = (enriches) => ({
    ...JS_SDK,
    'ravensight.config.json': JSON.stringify({ kinds: 'explicit', trackFunctions: [enriches ? { name: 'emit', enriches } : 'emit'] }),
    'src/a.js': "function emit(name, data) {\n  rs.track(name, data)\n}\nemit('chapter_finished', { chapter: 2 })\n",
  });
  assert.deepEqual(warned(scanProject(makeProject(t, files(['rs_kind', 'run_id'])))), []);
  assert.deepEqual(warned(scanProject(makeProject(t, files(['run_id'])))), [[4, 'warning']]);
  assert.deepEqual(warned(scanProject(makeProject(t, files(null)))), [[4, 'warning']]);
});

test('Swift and GDScript dictionaries are read for rs_kind', (t) => {
  const scan = scanProject(
    makeProject(t, {
      ...EXPLICIT,
      'project.godot': 'config_version=5\n',
      'addons/ravensight/Ravensight.gd': 'extends Node\n',
      'main.gd': 'func _ready():\n\tRavensight.track("level_start", {"rs_kind": "level_start"})\n\tRavensight.track("door_entered", {"door": 1})\n',
    }),
  );
  assert.deepEqual(warned(scan), [[3, 'warning']]);
});

test('by default name_without_kind is an info, since detection by name is a documented default', (t) => {
  const files = {
    ...JS_SDK,
    'src/a.js': "rs.track('checkout_started', { cart: 3 })\nrs.track('level_start')\n",
  };
  const scan = scanProject(makeProject(t, files));
  assert.deepEqual(warned(scan), [
    [1, 'info'],
    [2, 'info'],
  ]);
  assert.equal(scan.totals.warnings, 1, 'only no_ingest_key');
  const named = scanProject(makeProject(t, { ...files, 'ravensight.config.json': '{"kinds": "name"}' }));
  assert.deepEqual(warned(named).map((r) => r[1]), ['info', 'info']);
});

test('kinds is validated', (t) => {
  for (const bad of ['"strict"', 'true', '["explicit"]']) {
    const dir = makeProject(t, { 'ravensight.config.json': `{"kinds": ${bad}}` });
    assert.throws(() => loadConfig(dir), ConfigError, bad);
  }
});
