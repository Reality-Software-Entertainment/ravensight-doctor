import test from 'node:test';
import assert from 'node:assert/strict';
import { scanProject } from '../lib/cli.js';
import { makeProject, byId, ids } from './helpers.js';

// A web game that creates the game client at app start or on a public page
// counts every website visitor as a player. game_sdk_outside_game warns
// about it from source, only in a project that has public pages.
const ID = 'game_sdk_outside_game';
const KEY = "'gt_pub_" + 'a'.repeat(32) + "'";
const routerApp = { 'package.json': JSON.stringify({ name: 'site', dependencies: { ravensight: '^0.12.0', 'vue-router': '^4.0.0' } }) };
const client = `new Ravensight({ ingestKey: ${KEY}, gameVersion: '1.0.0' })`;

test('a client created at the top of the app entry warns, with the guide and an honest note', (t) => {
  const dir = makeProject(t, {
    ...routerApp,
    'src/main.js': `import Ravensight from 'ravensight';\nimport { createApp } from 'vue';\n\nconst rs = ${client};\nrs.init();\n`,
  });
  const found = byId(scanProject(dir).findings, ID);
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'warning');
  assert.equal(found[0].file, 'src/main.js');
  assert.equal(found[0].line, 4);
  assert.match(found[0].title, /starts when the app loads/);
  assert.match(found[0].detail, /every visitor/);
  assert.match(found[0].detail, /website tracker/);
  assert.match(found[0].detail, /identify/);
  assert.match(found[0].detail, /https:\/\/ravensight\.io\/docs\/web-games\//);
  assert.match(found[0].detail, /false alarm/);
  assert.doesNotMatch(found[0].detail, /[–—]/);
});

test('a module that creates the client when it is first imported warns', (t) => {
  const dir = makeProject(t, {
    ...routerApp,
    'src/lib/analytics.js': `import Ravensight from 'ravensight';\nexport const rs = ${client};\n`,
  });
  const found = byId(scanProject(dir).findings, ID);
  assert.equal(found.length, 1);
  assert.equal(found[0].file, 'src/lib/analytics.js');
  assert.match(found[0].detail, /first imported/);
});

test('a client created by a public page component warns', (t) => {
  const dir = makeProject(t, {
    ...routerApp,
    'src/pages/Landing.vue': `<template><main /></template>\n<script setup>\nimport Ravensight from 'ravensight'\nconst rs = ${client}\n</script>\n`,
  });
  const found = byId(scanProject(dir).findings, ID);
  assert.equal(found.length, 1);
  assert.equal(found[0].file, 'src/pages/Landing.vue');
  assert.match(found[0].title, /public page/);
});

test('a client created inside a function that the entry calls at startup warns at the creation', (t) => {
  const dir = makeProject(t, {
    ...routerApp,
    'src/lib/telemetry.js': [
      "import Ravensight from 'ravensight';",
      'let rs = null;',
      'function loadRavensight() {',
      `  rs = ${client};`,
      '}',
      'export function initTelemetry() {',
      '  loadRavensight();',
      '}',
      '',
    ].join('\n'),
    'src/main.js': "import { initTelemetry } from './lib/telemetry';\ninitTelemetry();\n",
  });
  const found = byId(scanProject(dir).findings, ID);
  assert.equal(found.length, 1);
  assert.equal(found[0].file, 'src/lib/telemetry.js');
  assert.equal(found[0].line, 4);
  assert.match(found[0].detail, /src\/main\.js/);
});

// The shape one of our own web games had: the entry calls initTelemetry, which
// reaches the constructor three calls down, through a dynamic import.
const deepChain = (gate) => [
  "let loading = null;",
  "let inApp = false;",
  "export function setAppRoute(app) { inApp = app; }",
  "function makeRavensight(Ravensight) {",
  `  return new Ravensight({ ingestKey: ${KEY} });`,
  "}",
  "function startRavensight(Ravensight) {",
  gate ? "  if (!inApp) return;" : "  // no gate",
  "  makeRavensight(Ravensight);",
  "}",
  "function loadRavensight() {",
  "  return import('ravensight').then(({ Ravensight }) => startRavensight(Ravensight));",
  "}",
  "export function initTelemetry() {",
  "  if (loading) return loading;",
  "  loading = loadRavensight();",
  "  return loading;",
  "}",
  "",
].join('\n');

test('a client the entry reaches through several calls in one file warns', (t) => {
  const dir = makeProject(t, {
    ...routerApp,
    'src/lib/telemetry.js': deepChain(false),
    'src/main.js': "import { initTelemetry } from './lib/telemetry'\ninitTelemetry()\n",
  });
  const found = byId(scanProject(dir).findings, ID);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 5);
  assert.match(found[0].detail, /src\/main\.js:2/);
});

test('the same chain behind a route or sign in check does not warn', (t) => {
  const dir = makeProject(t, {
    ...routerApp,
    'src/lib/telemetry.js': deepChain(true),
    'src/main.js': "import { initTelemetry } from './lib/telemetry'\ninitTelemetry()\n",
  });
  assert.ok(!ids(scanProject(dir).findings).includes(ID));
});

// The other: a root component calls screen() on every page, which loads the
// SDK and builds it under a destructured alias.
test('an alias from a dynamic import, reached from the root component, warns', (t) => {
  const dir = makeProject(t, {
    'package.json': JSON.stringify({ name: 'web', dependencies: { ravensight: '^0.12.0' } }),
    'src/ui/landing/LandingPage.tsx': 'export function LandingPage() { return null; }\n',
    'src/lib/telemetry.ts': [
      'function loadRavensight(): Promise<boolean> {',
      "  return import('ravensight').then(({ Ravensight: Client }) => {",
      `    const client = new Client({ ingestKey: ${KEY} });`,
      '    return Boolean(client);',
      '  });',
      '}',
      'export function screen(location: string): void {',
      '  void loadRavensight();',
      '}',
      '',
    ].join('\n'),
    'src/app.tsx': "import { screen } from './lib/telemetry';\nexport function App() {\n  useEffect(() => screen('home'), []);\n}\n",
  });
  const found = byId(scanProject(dir).findings, ID);
  assert.equal(found.length, 1);
  assert.equal(found[0].file, 'src/lib/telemetry.ts');
  assert.match(found[0].detail, /src\/app\.tsx:3/);
});

test('a client created only from an in-game view does not warn', (t) => {
  const dir = makeProject(t, {
    ...routerApp,
    'src/game/session.js': `import Ravensight from 'ravensight';\nlet rs = null;\nexport async function startGame(account) {\n  if (!rs) rs = ${client};\n  await rs.init();\n}\n`,
    'src/views/GameView.vue': "<script setup>\nimport { startGame } from '../game/session'\nstartGame()\n</script>\n",
    'src/main.js': "import { createApp } from 'vue';\ncreateApp({}).mount('#app');\n",
  });
  assert.ok(!ids(scanProject(dir).findings).includes(ID));
});

test('an aliased import is followed', (t) => {
  const dir = makeProject(t, {
    ...routerApp,
    'src/main.ts': `import RS from 'ravensight';\nconst game = new RS({ ingestKey: ${KEY} });\n`,
  });
  assert.equal(byId(scanProject(dir).findings, ID).length, 1);
});

test('a plain HTML5 game with no public pages never warns', (t) => {
  const dir = makeProject(t, {
    'package.json': JSON.stringify({ name: 'game', dependencies: { ravensight: '^0.12.0' } }),
    'index.html': '<!doctype html><canvas id="game"></canvas><script type="module" src="./main.js"></script>\n',
    'main.js': `import Ravensight from 'ravensight';\nconst rs = ${client};\nrs.init();\n`,
  });
  assert.ok(!ids(scanProject(dir).findings).includes(ID));
});

test('a game server and the website tracker on a public page never warn', (t) => {
  const dir = makeProject(t, {
    ...routerApp,
    'server/index.js': `import Ravensight from 'ravensight';\nconst rs = ${client};\n`,
    'src/pages/Landing.vue': "<script setup>\nimport { createSiteTracker } from 'ravensight'\nconst site = createSiteTracker({ key: 'gt_site_" + 'b'.repeat(32) + "' })\n</script>\n",
  });
  assert.ok(!ids(scanProject(dir).findings).includes(ID));
});

test('public page names alone mark a site, without a router dependency', (t) => {
  const dir = makeProject(t, {
    'package.json': JSON.stringify({ name: 'site', dependencies: { ravensight: '^0.12.0' } }),
    'src/ui/landing.ts': 'export const landing = 1;\n',
    'src/app.ts': `import Ravensight from 'ravensight';\nexport const rs = ${client};\n`,
  });
  assert.equal(byId(scanProject(dir).findings, ID).length, 1);
});
