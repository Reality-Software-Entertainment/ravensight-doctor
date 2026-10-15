// 0.4.2: a wrapper that enriches every payload centrally.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scanProject } from '../lib/cli.js';
import { parseTrackFnSpec, loadConfig, ConfigError } from '../lib/config.js';
import { makeProject, byId, runCli } from './helpers.js';

const TELEMETRY_SWIFT = [
  'import Ravensight', // 1
  '', // 2
  'enum Telemetry {', // 3
  '    static func emit(_ name: String, _ run: Run, _ props: [String: Any] = [:]) {', // 4
  '        var data = props', // 5
  '        data["run_id"] = run.id', // 6
  '        data["rs_kind"] = "none"', // 7
  '        Ravensight.track(name, data)', // 8
  '    }', // 9
  '}', // 10
  '', // 11
  'func spend(run: Run, id: String, delta: Int) {', // 12
  '    Telemetry.emit("resource_changed", run, ["resource_id": id, "amount": delta])', // 13
  '}', // 14
].join('\n');

const CONTRACT = {
  events: { resource_changed: { required: ['run_id', 'rs_kind', 'resource_id', 'amount'] } },
};

function project(t, trackFunctions) {
  return makeProject(t, {
    'Package.swift': '// dependencies: ravensight-swift\n',
    'Sources/Game/Telemetry.swift': TELEMETRY_SWIFT,
    'ravensight.contract.json': JSON.stringify(CONTRACT),
    'ravensight.config.json': JSON.stringify({ trackFunctions, ingestKey: { source: 'build' } }),
  });
}

test('keys a wrapper declares in enriches are never reported missing at its call sites', (t) => {
  const scan = scanProject(project(t, [{ name: '*.emit', enriches: ['run_id', 'rs_kind', 'schema_version', 'build_id'] }]));
  assert.deepEqual(byId(scan.allFindings, 'contract_prop_missing'), []);
  assert.deepEqual(byId(scan.allFindings, 'contract_prop_unproven'), []);
  assert.equal(scan.contractSummary.propSitesChecked, 1);
});

test('without enriches a wrapper call site is contract_prop_unproven at info, never a warning', (t) => {
  const scan = scanProject(project(t, ['*.emit']));
  assert.deepEqual(byId(scan.allFindings, 'contract_prop_missing'), []);
  const [f, ...rest] = byId(scan.allFindings, 'contract_prop_unproven');
  assert.equal(rest.length, 0);
  assert.equal(f.severity, 'info');
  assert.equal(f.file, 'Sources/Game/Telemetry.swift');
  assert.equal(f.line, 13);
  assert.match(f.detail, /not provable statically; the runtime trace is the evidence/);
  assert.match(f.detail, /"enriches": \["run_id", "rs_kind"\]/);
  assert.equal(scan.contractSummary.propsUnproven, 1);
  assert.deepEqual(scan.allFindings.filter((x) => x.severity !== 'info' && x.id.startsWith('contract_')), []);
});

test('a wrapper that declares enriches without a required key still gets contract_prop_missing for it', (t) => {
  const scan = scanProject(project(t, [{ name: '*.emit', enriches: ['run_id'] }]));
  const [f] = byId(scan.allFindings, 'contract_prop_missing');
  assert.equal(f.severity, 'warning');
  assert.match(f.title, /rs_kind/);
  assert.doesNotMatch(f.title, /run_id/);
  assert.match(f.detail, /declares that it adds run_id/);
  assert.deepEqual(byId(scan.allFindings, 'contract_prop_unproven'), []);
});

test('a direct SDK call missing a key is still contract_prop_missing', (t) => {
  const dir = makeProject(t, {
    'package.json': JSON.stringify({ dependencies: { ravensight: '^0.3.0' } }),
    'ravensight.contract.json': JSON.stringify(CONTRACT),
    'src/a.js': "rs.track('resource_changed', { resource_id: 'gold', amount: 1 });\n",
  });
  const [f] = byId(scanProject(dir).allFindings, 'contract_prop_missing');
  assert.equal(f.severity, 'warning');
  assert.match(f.title, /run_id, rs_kind/);
});

test('enriches does not relax the trace replay', async (t) => {
  const dir = project(t, [{ name: '*.emit', enriches: ['run_id', 'rs_kind'] }]);
  const trace = path.join(dir, 'trace.jsonl');
  fs.writeFileSync(trace, JSON.stringify({ event_name: 'resource_changed', session_id: 's1', props: { resource_id: 'g', amount: 2, rs_kind: 'none' } }) + '\n');
  const { stdout } = await runCli([dir, '--json', '--trace', trace]);
  const rep = JSON.parse(stdout);
  assert.deepEqual(rep.trace.findings.map((f) => f.id), ['trace_missing_depth']);
});

test('enriches is validated and counted as a known entry key', (t) => {
  assert.deepEqual(parseTrackFnSpec({ name: 'emit', enriches: [' run_id ', 'run_id', 'rs_kind'] }, 'config').enriches, ['run_id', 'rs_kind']);
  assert.throws(() => parseTrackFnSpec({ name: 'emit', enriches: [] }, 'config'), ConfigError);
  assert.throws(() => parseTrackFnSpec({ name: 'emit', enriches: 'run_id' }, 'config'), ConfigError);
  assert.throws(() => parseTrackFnSpec({ name: 'emit', enriches: ['has space'] }, 'config'), ConfigError);
  const dir = makeProject(t, { 'ravensight.config.json': JSON.stringify({ trackFunctions: [{ name: 'emit', enriches: ['run_id'] }] }) });
  assert.deepEqual(loadConfig(dir).unknownKeys, []);
});

test('three evidence lines: static with the unproven count, the trace, and live delivery', async (t) => {
  const dir = project(t, ['*.emit']);
  const trace = path.join(dir, 'trace.jsonl');
  fs.writeFileSync(trace, JSON.stringify({ event_name: 'resource_changed', session_id: 's1', props: { amount: 2 } }) + '\n');
  const pretty = await runCli([dir, '--trace', trace]);
  const lines = pretty.stdout.split('\n').map((l) => l.trim());
  const at = lines.indexOf('Static: pass (1 finding not provable statically)');
  assert.ok(at > 0, pretty.stdout);
  assert.deepEqual(lines.slice(at + 1, at + 3), ['Runtime trace: warn', 'Live delivery: not run']);
  assert.ok(at > lines.findIndex((l) => l.includes('contract_prop_unproven')), 'printed after the findings');
  const rep = JSON.parse((await runCli([dir, '--json', '--trace', trace])).stdout);
  assert.deepEqual(rep.evidence, { static: 'pass', notProvableStatically: 1, trace: 'warn', live: 'not run' });
  assert.equal(rep.summary.status, 'pass', 'the top-level status stays the static verdict');
  const clean = JSON.parse((await runCli([dir, '--json'])).stdout);
  assert.equal(clean.evidence.trace, 'not run');
});
