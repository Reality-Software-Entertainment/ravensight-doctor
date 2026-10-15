// 0.4.2: event names from simple constant members.

import test from 'node:test';
import assert from 'node:assert/strict';
import { scanProject } from '../lib/cli.js';
import { objectConstants, importsName } from '../lib/constants.js';
import { makeProject, byId } from './helpers.js';

const BASE = {
  'package.json': JSON.stringify({ dependencies: { ravensight: '^0.3.0' } }),
  'ravensight.config.json': JSON.stringify({ trackFunctions: ['capture'] }),
};

const callsIn = (scan, file) =>
  scan.inventory.trackCalls.filter((c) => c.file === file).map((c) => [c.line, c.name, c.constant ?? null]);

test('a member of a same file constant resolves to its literal, as const included', (t) => {
  const scan = scanProject(
    makeProject(t, {
      ...BASE,
      'src/a.ts': [
        "const EVENTS = { registered: 'registered', 'level-up': \"level_up\" } as const", // 1
        'capture(EVENTS.registered)', // 2
        "capture(EVENTS['level-up'])", // 3
        'capture(EVENTS.unknown)', // 4
      ].join('\n'),
    }),
  );
  assert.deepEqual(callsIn(scan, 'src/a.ts'), [
    [2, 'registered', 'EVENTS.registered'],
    [3, 'level_up', 'EVENTS.level-up'],
    [4, null, null],
  ]);
  assert.deepEqual(scan.inventory.eventNames.map((e) => e.name).sort(), ['level_up', 'registered']);
  assert.equal(byId(scan.allFindings, 'tracking_unresolved').length, 1);
});

test('an imported constant from another scanned file resolves; the same file wins', (t) => {
  const scan = scanProject(
    makeProject(t, {
      ...BASE,
      'src/events.ts': "export const EVENTS = Object.freeze({\n  registered: 'registered',\n  paid: 'purchase_completed',\n})\n",
      'src/signup.ts': "import { EVENTS } from './events'\ncapture(EVENTS.registered)\ncapture(EVENTS.paid)\n",
      'src/local.ts': "import { EVENTS as E } from './events'\nconst EVENTS = { registered: 'local_registered' }\ncapture(EVENTS.registered)\n",
    }),
  );
  assert.deepEqual(callsIn(scan, 'src/signup.ts'), [
    [2, 'registered', 'EVENTS.registered'],
    [3, 'purchase_completed', 'EVENTS.paid'],
  ]);
  assert.deepEqual(callsIn(scan, 'src/local.ts'), [[3, 'local_registered', 'EVENTS.registered']]);
});

test('unresolved when not imported, not exported, ambiguous, or not a plain literal', (t) => {
  const scan = scanProject(
    makeProject(t, {
      ...BASE,
      'src/a.js': "export const A = { x: 'one' }\nconst HIDDEN = { x: 'hidden' }\nconst DYN = { x: `x_${n}`, y: make() }\n",
      'src/b.js': "export const A = { x: 'two' }\n",
      'src/c.js': "import { A, HIDDEN } from './a'\nimport { DYN } from './a'\ncapture(A.x)\ncapture(HIDDEN.x)\ncapture(DYN.x)\ncapture(DYN.y)\n",
      'src/d.js': 'capture(A.x)\n',
    }),
  );
  assert.deepEqual(callsIn(scan, 'src/c.js').map((r) => r[1]), [null, null, null, null]);
  assert.deepEqual(callsIn(scan, 'src/d.js').map((r) => r[1]), [null]);
});

test('objectConstants and importsName', () => {
  const c = objectConstants("export const E = { a: 'x', b: 1, c: `y` }\nconst F = { }\nconst G = { d: \"z\" }\nexport { G }\n");
  assert.deepEqual([...c.keys()], ['E', 'G']);
  assert.deepEqual([...c.get('E').values.keys()], ['a', 'c']);
  assert.equal(c.get('G').exported, true);
  assert.equal(importsName("import { a, EVENTS } from './e'", 'EVENTS'), true);
  assert.equal(importsName("import type { EVENTS } from './e'", 'EVENTS'), true);
  assert.equal(importsName("const { EVENTS } = require('./e')", 'EVENTS'), true);
  assert.equal(importsName("import { EVENTS as E } from './e'", 'EVENTS'), false);
  assert.equal(importsName("import EVENTS from './e'", 'EVENTS'), false);
});
