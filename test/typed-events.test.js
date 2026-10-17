import test from 'node:test';
import assert from 'node:assert/strict';
import { scanProject } from '../lib/cli.js';
import { buildTrackPatterns } from '../lib/checks.js';
import { parseTrackFnSpec } from '../lib/config.js';
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

test('godot: track_event and the typed helpers are recognised and named', (t) => {
  const scan = scanProject(
    makeProject(t, {
      ...GODOT,
      'scripts/game.gd':
        'func go():\n' +
        '\tRavensight.track_event("shop_opened", {"level": 1})\n' +
        '\tRavensight.track_purchase("iap", "gem_pack", 499, "usd")\n' +
        '\tRavensight.track_resource("sink", "gold", 10)\n' +
        '\tRavensight.track_progression("complete", "world1", {"p2": "level3"})\n' +
        '\tRavensight.track_error("error", "save failed")\n',
    }),
  );
  assert.equal(scan.inventory.trackCalls.length, 5);
  assert.equal(scan.inventory.unresolvedCalls, 0);
  assert.equal(byId(scan.findings, 'tracking_unresolved').length, 0);
  assert.deepEqual(names(scan), ['error', 'progression_complete', 'purchase', 'resource_sink', 'shop_opened']);
  assert.equal(byId(scan.findings, 'name_without_kind').length, 0);
});

test('unreal: ->TrackEvent and the typed helpers are recognised', (t) => {
  const scan = scanProject(
    makeProject(t, {
      ...UNREAL,
      'Source/MyGame/Stats.cpp':
        'void A() {\n' +
        '  Ravensight->TrackEvent(TEXT("enemy_defeated"), Data);\n' +
        '  Ravensight->TrackEventJson(TEXT("boss_phase"), TEXT("{}"));\n' +
        '  Ravensight->TrackPurchase(499, TEXT("usd"), TEXT("gem_pack"), TEXT("gems_500"), TEXT(""), TEXT(""), {}, TEXT(""));\n' +
        '  Ravensight->TrackPurchaseText(TEXT("499"), TEXT("usd"), TEXT("a"), TEXT("b"));\n' +
        '  Ravensight->TrackResource(TEXT("source"), TEXT("gold"), 120.0, TEXT(""), TEXT(""), {}, TEXT(""));\n' +
        '  Ravensight->TrackProgression(TEXT("fail"), TEXT("world1"), TEXT("level2"), TEXT(""), false, 0.0, {}, TEXT(""));\n' +
        '  Ravensight->TrackError(TEXT("warning"), TEXT("pool over budget"), TEXT(""), {}, TEXT(""));\n' +
        '}\n',
    }),
  );
  assert.equal(scan.inventory.trackCalls.length, 7);
  assert.equal(scan.inventory.unresolvedCalls, 0);
  assert.deepEqual(names(scan), [
    'boss_phase',
    'enemy_defeated',
    'error',
    'progression_fail',
    'purchase',
    'resource_source',
  ]);
});

test('the helper names of every other SDK are recognised', () => {
  const forms = (src) => {
    const found = [];
    for (const f of buildTrackPatterns()) {
      f.re.lastIndex = 0;
      if (f.re.test(src)) found.push(f.name);
    }
    return found;
  };
  const cases = [
    ['rs.trackPurchase({ amount: 499 })', 'purchase helper'],
    ['this.rs.trackResource({ flow: "sink" })', 'resource helper'],
    ['ravensight.trackProgression({ status: "start" })', 'progression helper'],
    ['Ravensight.trackError("error", "x")', 'error helper'],
    ['Ravensight.TrackPurchase(499, "usd", "a", "b");', 'purchase helper'],
    ['ravensight.purchase(499, "usd", "bundle", "starter")', 'purchase helper'],
    ['ravensight.resource("source", "gold", 1)', 'resource helper'],
    ['ravensight.progression("fail", "w1")', 'progression helper'],
    ['ravensight.error("critical", "boom")', 'error helper'],
    ['client.track_purchase(499, "usd", "pack", "gems");', 'purchase helper'],
    ['rs.track_resource(analytics, rs.FLOW_SINK, "gold", 10)', 'resource helper'],
    ['rs.track_progression(analytics, rs.STATUS_COMPLETE, "w1")', 'progression helper'],
    ['rs.track_error(analytics, rs.SEVERITY_ERROR, "x")', 'error helper'],
  ];
  for (const [src, form] of cases) assert.deepEqual(forms(src), [form], src);
  // Unrelated receivers and look-alike names are not track calls.
  assert.deepEqual(forms('analytics.trackPurchase(1)'), []);
  assert.deepEqual(forms('myravensight.purchase(1)'), []);
  assert.deepEqual(forms('shop.purchase(1)'), []);
});

test('a typed helper call with a variable flow stays unresolved, not guessed', (t) => {
  const scan = scanProject(
    makeProject(t, {
      ...GODOT,
      'scripts/game.gd': 'func go(flow):\n\tRavensight.track_resource(flow, "gold", 10)\n\tRavensight.track_event("a")\n',
    }),
  );
  assert.equal(scan.inventory.trackCalls.length, 2);
  assert.equal(scan.inventory.unresolvedCalls, 1);
  assert.equal(byId(scan.findings, 'tracking_unresolved').length, 1);
});

test('a custom track function still works beside the built in helpers', (t) => {
  const dir = makeProject(t, {
    ...GODOT,
    'scripts/game.gd': 'func go():\n\tlog_event("shop_opened")\n\tRavensight.track_purchase("iap", "x", 99, "usd")\n',
  });
  const scan = scanProject(dir, { trackFunctions: [parseTrackFnSpec('log_event')] });
  assert.deepEqual(names(scan), ['purchase', 'shop_opened']);
  assert.equal(scan.inventory.unresolvedCalls, 0);
});

test('a project wrapper named like a helper takes precedence over the built in form', (t) => {
  const dir = makeProject(t, {
    'package.json': JSON.stringify({ dependencies: { ravensight: '^0.5.0' } }),
    'src/shop.js': 'rs.trackPurchase("custom_purchase_name");\n',
  });
  const scan = scanProject(dir, { trackFunctions: [parseTrackFnSpec('*.trackPurchase')] });
  assert.deepEqual(names(scan), ['custom_purchase_name']);
});
