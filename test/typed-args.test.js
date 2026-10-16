import test from 'node:test';
import assert from 'node:assert/strict';
import { scanProject } from '../lib/cli.js';
import { makeProject, byId } from './helpers.js';

const GODOT = {
  'project.godot': 'config_version=5\n',
  'addons/ravensight/Ravensight.gd': 'extends Node\nfunc track(n, d := {}):\n\treturn true\n',
};
const UNREAL = {
  'MyGame.uproject': '{ "EngineAssociation": "5.3" }\n',
  'Plugins/Ravensight/Ravensight.uplugin': '{ "FriendlyName": "Ravensight" }\n',
};

function names(scan) {
  return scan.inventory.eventNames.map((n) => n.name).sort();
}

test('a word inside another argument never names the flow or status', (t) => {
  const scan = scanProject(
    makeProject(t, {
      ...GODOT,
      'scripts/game.gd':
        'func go(flow, st):\n' +
        '\tRavensight.track_resource(flow, "source_gold", 1)\n' +
        '\tRavensight.track_progression(st, "tutorial_complete")\n',
    }),
  );
  assert.equal(scan.inventory.trackCalls.length, 2);
  assert.equal(scan.inventory.unresolvedCalls, 2);
  assert.deepEqual(names(scan), []);
  assert.equal(byId(scan.findings, 'tracking_unresolved').length, 1);
});

test('odin: rs.FLOW_SINK and rs.STATUS_COMPLETE after the client resolve', (t) => {
  const scan = scanProject(
    makeProject(t, {
      'main.odin':
        'package main\nimport rs "ravensight"\nmain :: proc() {\n' +
        '\trs.track_resource(analytics, rs.FLOW_SINK, "gold", 10)\n' +
        '\trs.track_progression(analytics, rs.STATUS_COMPLETE, "w1")\n}\n',
    }),
  );
  assert.deepEqual(names(scan), ['progression_complete', 'resource_sink']);
  assert.equal(scan.inventory.unresolvedCalls, 0);
});

test('unity: RavensightTyped.Source and .Fail resolve', (t) => {
  const scan = scanProject(
    makeProject(t, {
      'Assets/scene.unity': 'placeholder\n',
      'ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 2022.3.1f1\n',
      'Assets/Game.cs':
        'class G { void A() {\n' +
        '  Ravensight.TrackResource(RavensightTyped.Source, "gold", 250);\n' +
        '  Ravensight.TrackProgression(RavensightTyped.Fail, "world1", "level2");\n' +
        '} }\n',
    }),
  );
  assert.deepEqual(names(scan), ['progression_fail', 'resource_source']);
  assert.equal(scan.inventory.unresolvedCalls, 0);
});

test('swift: labelled flow and status resolve', (t) => {
  const scan = scanProject(
    makeProject(t, {
      'Package.swift': '// swift-tools-version:5.9\n',
      'Sources/Game/Shop.swift':
        'func a() {\n' +
        '  Ravensight.trackResource(flow: "sink", resource: "gold", amount: 250)\n' +
        '  Ravensight.trackProgression(status: "start", p1: "world1")\n' +
        '}\n',
    }),
  );
  assert.deepEqual(names(scan), ['progression_start', 'resource_sink']);
  assert.equal(scan.inventory.unresolvedCalls, 0);
});

test('javascript: a keyed literal in the options object resolves', (t) => {
  const scan = scanProject(
    makeProject(t, {
      'package.json': JSON.stringify({ dependencies: { ravensight: '^0.5.0' } }),
      'src/a.js':
        "rs.trackResource({ flow: 'sink', resource: 'gold', amount: 1 });\n" +
        "rs.trackProgression({ p1: 'w', status: 'complete' });\n",
    }),
  );
  assert.deepEqual(names(scan), ['progression_complete', 'resource_sink']);
});

test('unreal: a multi-line call resolves', (t) => {
  const scan = scanProject(
    makeProject(t, {
      ...UNREAL,
      'Source/MyGame/Shop.cpp':
        'void A() {\n' +
        '  Ravensight->TrackResource(\n' +
        '      TEXT("sink"),\n' +
        '      TEXT("gold"),\n' +
        '      45.0, TEXT("shop"), TEXT("potion"), {}, TEXT(""));\n' +
        '}\n',
    }),
  );
  assert.deepEqual(names(scan), ['resource_sink']);
  assert.equal(scan.inventory.unresolvedCalls, 0);
});
