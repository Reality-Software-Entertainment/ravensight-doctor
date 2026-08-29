import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { scanProject } from '../lib/cli.js';
import { buildReport } from '../lib/report.js';
import { fixture, makeProject, ids, byId } from './helpers.js';

test('godot fixture: SDK found, cardinality warning, no errors', () => {
  const scan = scanProject(fixture('godot-project'));
  assert.equal(scan.engine, 'godot');
  assert.ok(!ids(scan.findings).includes('sdk_missing'));
  assert.ok(!ids(scan.findings).includes('no_ingest_key'));
  assert.ok(!ids(scan.findings).includes('no_track_calls'));
  assert.ok(!ids(scan.findings).includes('flush_on_exit_missing'));
  const card = byId(scan.findings, 'event_name_cardinality');
  assert.equal(card.length, 1);
  assert.equal(card[0].severity, 'warning');
  assert.equal(card[0].file, 'scripts/player.gd');
  assert.equal(card[0].line, 7);
  assert.equal(scan.totals.errors, 0);
});

test('godot fixture: report status is warn', () => {
  const scan = scanProject(fixture('godot-project'));
  const report = buildReport(scan.engine, scan.findings, scan.totals, '0.1.0');
  assert.equal(report.summary.status, 'warn');
  assert.equal(report.summary.errors, 0);
  assert.ok(report.summary.warnings >= 1);
});

test('js fixture: too long event name is an error', () => {
  const scan = scanProject(fixture('js-project'));
  assert.equal(scan.engine, 'javascript');
  assert.ok(!ids(scan.findings).includes('sdk_missing'));
  const long = byId(scan.findings, 'event_name_too_long');
  assert.equal(long.length, 1);
  assert.equal(long[0].severity, 'error');
  assert.equal(long[0].file, 'src/game.js');
});

test('js fixture: template literal event name warns on cardinality', () => {
  const scan = scanProject(fixture('js-project'));
  const card = byId(scan.findings, 'event_name_cardinality');
  assert.equal(card.length, 1);
  assert.equal(card[0].file, 'src/game.js');
});

test('js fixture: report status is fail', () => {
  const scan = scanProject(fixture('js-project'));
  const report = buildReport(scan.engine, scan.findings, scan.totals, '0.1.0');
  assert.equal(report.summary.status, 'fail');
  assert.ok(report.summary.errors >= 1);
});

test('secret fixture: all three planted credentials are flagged', () => {
  const scan = scanProject(fixture('secret-project'));
  const wrong = byId(scan.findings, 'wrong_key_type');
  assert.equal(wrong.length, 3);
  for (const f of wrong) {
    assert.equal(f.severity, 'error');
    assert.equal(f.file, 'config/secrets.cfg');
  }
  const details = wrong.map((f) => f.detail).join('\n');
  assert.ok(details.includes('gt_mcp_E...'));
  assert.ok(details.includes('sk_live_...'));
  assert.ok(details.includes('AKIAIOSF...'));
});

test('secret fixture: full token values never appear in findings', () => {
  const scan = scanProject(fixture('secret-project'));
  const json = JSON.stringify(scan.findings);
  assert.ok(!json.includes('gt_mcp_EXAMPLEEXAMPLEEXAMPLE0000'));
  assert.ok(!json.includes('sk_live_EXAMPLEFAKE0000000'));
  assert.ok(!json.includes('AKIAIOSFODNN7EXAMPLE'));
});

test('secret fixture: no gt_live key means no_ingest_key warning', () => {
  const scan = scanProject(fixture('secret-project'));
  assert.equal(byId(scan.findings, 'no_ingest_key').length, 1);
  assert.equal(scan.liveKeys.length, 0);
});

test('big payload fixture: oversized inline dictionary warns', () => {
  const scan = scanProject(fixture('big-payload-project'));
  assert.equal(scan.engine, 'javascript');
  const big = byId(scan.findings, 'large_inline_payload');
  assert.equal(big.length, 1);
  assert.equal(big[0].severity, 'warning');
  assert.equal(big[0].file, 'src/snapshot.js');
});

test('big payload fixture: normal sized payloads do not warn', () => {
  const scan = scanProject(fixture('godot-project'));
  assert.equal(byId(scan.findings, 'large_inline_payload').length, 0);
});

test('sdk_missing fires for a godot project without Ravensight.gd', (t) => {
  const dir = makeProject(t, {
    'project.godot': 'config_version=5\n',
    'main.gd': 'extends Node\nfunc _ready():\n\tRavensight.track("boot")\n',
  });
  const scan = scanProject(dir);
  assert.equal(scan.engine, 'godot');
  const missing = byId(scan.findings, 'sdk_missing');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].severity, 'error');
});

test('no_track_calls fires when the SDK is present but unused', (t) => {
  const dir = makeProject(t, {
    'project.godot': 'config_version=5\n',
    'addons/ravensight/Ravensight.gd': 'extends Node\nfunc track(n, d := {}):\n\treturn true\n',
  });
  const scan = scanProject(dir);
  const info = byId(scan.findings, 'no_track_calls');
  assert.equal(info.length, 1);
  assert.equal(info[0].severity, 'info');
});

test('track calls inside the SDK file itself do not count', (t) => {
  const dir = makeProject(t, {
    'project.godot': 'config_version=5\n',
    'addons/ravensight/Ravensight.gd':
      'extends Node\n# Example: Ravensight.track("level_" + str(n))\nfunc track(n, d := {}):\n\treturn true\n',
  });
  const scan = scanProject(dir);
  assert.equal(byId(scan.findings, 'event_name_cardinality').length, 0);
  assert.equal(byId(scan.findings, 'no_track_calls').length, 1);
});

test('flush_on_exit_missing fires for a custom integration with no flush', (t) => {
  const dir = makeProject(t, {
    'src/analytics.c': 'void boot(void) {\n  track(client, "game_started");\n}\n',
  });
  const scan = scanProject(dir);
  assert.equal(scan.engine, 'custom');
  assert.equal(byId(scan.findings, 'flush_on_exit_missing').length, 1);
});

test('flush_on_exit_missing stays quiet when a flush exists', (t) => {
  const dir = makeProject(t, {
    'src/analytics.c':
      'void boot(void) {\n  track(client, "game_started");\n}\nvoid shutdown(void) {\n  flush(client);\n}\n',
  });
  const scan = scanProject(dir);
  assert.equal(byId(scan.findings, 'flush_on_exit_missing').length, 0);
});

test('flush_on_exit_missing never fires for SDK engines', () => {
  const scan = scanProject(fixture('godot-project'));
  assert.equal(byId(scan.findings, 'flush_on_exit_missing').length, 0);
});

test('event names with multi digit numbers warn on cardinality', (t) => {
  const dir = makeProject(t, {
    'project.godot': 'config_version=5\n',
    'addons/ravensight/Ravensight.gd': 'extends Node\nfunc track(n, d := {}):\n\treturn true\n',
    'main.gd': 'extends Node\nfunc go():\n\tRavensight.track("level_42_completed")\n',
  });
  const scan = scanProject(dir);
  const card = byId(scan.findings, 'event_name_cardinality');
  assert.equal(card.length, 1);
  assert.ok(card[0].detail.includes('multi digit number'));
});

test('plain single digit event names do not warn', (t) => {
  const dir = makeProject(t, {
    'project.godot': 'config_version=5\n',
    'addons/ravensight/Ravensight.gd': 'extends Node\nfunc track(n, d := {}):\n\treturn true\n',
    'main.gd': 'extends Node\nfunc go():\n\tRavensight.track("chapter_1_started")\n',
  });
  const scan = scanProject(dir);
  assert.equal(byId(scan.findings, 'event_name_cardinality').length, 0);
});

test('odin track(client, ...) pattern is recognized', (t) => {
  const dir = makeProject(t, {
    'main.odin': 'main :: proc() {\n\ttrack(client, "game_started")\n}\n',
    'ravensight.odin': '// Fake SDK stub\ntrack :: proc(c: ^Client, name: string) {}\n',
  });
  const scan = scanProject(dir);
  assert.equal(scan.engine, 'odin');
  assert.ok(!ids(scan.findings).includes('sdk_missing'));
  assert.ok(!ids(scan.findings).includes('no_track_calls'));
});

test('receiver boundary: colors.track( does not match rs.track(', (t) => {
  const dir = makeProject(t, {
    'project.godot': 'config_version=5\n',
    'addons/ravensight/Ravensight.gd': 'extends Node\nfunc track(n, d := {}):\n\treturn true\n',
    'main.gd': 'extends Node\nfunc go():\n\tcolors.track("palette_9999_changed")\n',
  });
  const scan = scanProject(dir);
  assert.equal(byId(scan.findings, 'event_name_cardinality').length, 0);
  assert.equal(byId(scan.findings, 'no_track_calls').length, 1);
});

test('findings are truncated to 100 with an info marker', (t) => {
  let planted = '# FIXTURE: fake tokens for the truncation test, none are real.\n';
  for (let i = 0; i < 150; i++) {
    planted += `token_${i} = "gt_mcp_FAKEFAKE${String(i).padStart(8, '0')}"\n`;
  }
  const dir = makeProject(t, { 'secrets.txt': planted });
  const scan = scanProject(dir);
  assert.equal(scan.findings.length, 100);
  assert.equal(scan.findings[99].id, 'findings_truncated');
  assert.equal(scan.findings[99].severity, 'info');
  assert.equal(scan.totals.errors, 150);
});

test('binary files and oversized files are skipped', (t) => {
  const dir = makeProject(t, {
    'project.godot': 'config_version=5\n',
    'addons/ravensight/Ravensight.gd': 'extends Node\nfunc track(n, d := {}):\n\treturn true\n',
  });
  fs.writeFileSync(`${dir}/sprite.bin`, Buffer.from([0, 1, 2, 0, 255, 0, 3]));
  fs.writeFileSync(`${dir}/huge.txt`, 'gt_mcp_FAKEFAKEFAKE0001 '.padEnd(3 * 1024 * 1024, 'x'));
  const scan = scanProject(dir);
  assert.equal(byId(scan.findings, 'wrong_key_type').length, 0);
});

test('skip directories are not scanned', (t) => {
  const dir = makeProject(t, {
    'project.godot': 'config_version=5\n',
    'addons/ravensight/Ravensight.gd': 'extends Node\nfunc track(n, d := {}):\n\treturn true\n',
    'node_modules/dep/index.js': 'const k = "gt_mcp_FAKEFAKEFAKE0002";\n',
    '.godot/cache.txt': 'gt_mcp_FAKEFAKEFAKE0003\n',
    'build/out.txt': 'gt_mcp_FAKEFAKEFAKE0004\n',
  });
  const scan = scanProject(dir);
  assert.equal(byId(scan.findings, 'wrong_key_type').length, 0);
});

test('finding text respects the report API caps', (t) => {
  const dir = makeProject(t, {
    'project.godot': 'config_version=5\n',
    'addons/ravensight/Ravensight.gd': 'extends Node\nfunc track(n, d := {}):\n\treturn true\n',
    'main.gd': `extends Node\nfunc go():\n\tRavensight.track("${'e'.repeat(600)}")\n`,
  });
  const scan = scanProject(dir);
  for (const f of scan.findings) {
    assert.ok(f.title.length <= 200);
    assert.ok(f.detail.length <= 1000);
    if (f.file) assert.ok(f.file.length <= 300);
  }
  assert.equal(byId(scan.findings, 'event_name_too_long').length, 1);
});
