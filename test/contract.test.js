// 0.4.0: the event contract (static part) and the trace replay.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scanProject } from '../lib/cli.js';
import { parseContract, ContractError } from '../lib/contract.js';
import { readTraceLines, parseTraceLine, replayTrace, MAX_TRACE_LINES } from '../lib/trace.js';
import { literalKeys, callPropKeys } from '../lib/props.js';
import { makeProject, byId, ids, runCli } from './helpers.js';

const JS_SDK = { 'package.json': JSON.stringify({ dependencies: { ravensight: '^0.3.0' } }) };

// The narrative game from the README: run checkpoints, choices and
// outcomes paired by decision_id, and unlocks earned once.
const CONTRACT = {
  events: {
    run_checkpoint: { required: ['run_id', 'chapter', 'foreground_seconds'], join: 'run_id' },
    choice_made: { required: ['decision_id', 'depth'], nonzero: ['depth'] },
    choice_outcome: { required: ['decision_id', 'outcome'], pairs_with: 'choice_made', join: 'decision_id' },
    progress_unlocked: { required: ['content_id'] },
  },
  cumulative: ['foreground_seconds'],
  attempt_ids: ['decision_id'],
  earned_once: { event: 'progress_unlocked', key: 'content_id' },
};

const STORY = [
  "import rs from 'ravensight';", // 1
  'export function checkpoint(run, chapter) {', // 2
  "  rs.track('run_checkpoint', { run_id: run.id, chapter, foreground_seconds: run.seconds });", // 3
  '}', // 4
  'export function choose(decision) {', // 5
  "  rs.track('choice_made', { decision_id: decision.id });", // 6
  "  rs.track('choice_outcome', {", // 7
  '    decision_id: decision.id,', // 8
  '    outcome: decision.result,', // 9
  '  });', // 10
  '}', // 11
].join('\n');

const TRACE = [
  { event_name: 'run_checkpoint', ts: '1', session_id: 's1', props: { run_id: 'r1', chapter: 1, foreground_seconds: 120 } },
  { event_name: 'choice_made', ts: '2', session_id: 's1', props: { decision_id: 'd1', depth: 2 } },
  { event_name: 'choice_outcome', ts: '3', session_id: 's1', props: { decision_id: 'd1', outcome: 'spared' } },
  { event_name: 'choice_outcome', ts: '4', session_id: 's1', props: { decision_id: 'd9', outcome: 'fled' } },
  { event_name: 'choice_made', ts: '5', session_id: 's1', props: { depth: 0 } },
  { event_name: 'progress_unlocked', ts: '6', session_id: 's1', props: { content_id: 'ending_a' } },
  { event: 'run_checkpoint', timestamp: '7', data: { session_id: 's2', run_id: 'r1', chapter: 2, foreground_seconds: 45 } },
  { event: 'progress_unlocked', timestamp: '8', data: { session_id: 's2', content_id: 'ending_a', loaded: true } },
  { event: 'progress_unlocked', timestamp: '9', data: { session_id: 's2', content_id: 'ending_a' } },
]
  .map((e) => JSON.stringify(e))
  .concat(['not json'])
  .join('\n');

function project(t, extra = {}) {
  return makeProject(t, {
    ...JS_SDK,
    'ravensight.contract.json': JSON.stringify(CONTRACT),
    'src/story.js': STORY,
    ...extra,
  });
}

// Static part

test('the static contract check reports missing events and missing props with file:line', (t) => {
  const scan = scanProject(project(t));
  const missing = byId(scan.allFindings, 'contract_event_missing');
  assert.deepEqual(
    missing.map((f) => f.title),
    ['Contract event "progress_unlocked" is not tracked anywhere in the scanned source'],
  );
  const props = byId(scan.allFindings, 'contract_prop_missing');
  assert.equal(props.length, 1);
  assert.equal(props[0].file, 'src/story.js');
  assert.equal(props[0].line, 6);
  assert.match(props[0].title, /choice_made.*depth/);
  assert.match(props[0].detail, /proves the key is missing in source/);
  assert.equal(scan.contractSummary.events, 4);
  assert.equal(scan.contractSummary.matched, 3);
  assert.equal(scan.contractSummary.propSitesChecked, 3);
});

test('a contract that names nothing in the scan is one info, not a warning per event', (t) => {
  const dir = makeProject(t, {
    ...JS_SDK,
    'ravensight.contract.json': JSON.stringify({ events: { a: {}, b: { required: ['x'] } } }),
    'src/game.js': "rs.track('other_event')\n",
  });
  const scan = scanProject(dir);
  assert.deepEqual(byId(scan.allFindings, 'contract_event_missing'), []);
  const info = byId(scan.allFindings, 'contract_unmatched');
  assert.equal(info.length, 1);
  assert.equal(info[0].severity, 'info');
});

test('no contract file means no contract block and no contract findings', (t) => {
  const dir = makeProject(t, { ...JS_SDK, 'src/game.js': "rs.track('a', { x: 1 })\n" });
  const scan = scanProject(dir);
  assert.equal(scan.contract, null);
  assert.ok(!ids(scan.allFindings).some((id) => id.startsWith('contract_')));
});

test('a props object the doctor cannot read is not checked', (t) => {
  const dir = makeProject(t, {
    ...JS_SDK,
    'ravensight.contract.json': JSON.stringify({ events: { a: { required: ['run_id'] } } }),
    'src/game.js': ["rs.track('a', { ...base })", "rs.track('a', props)", "rs.track('a')", "rs.track('a', { [k]: 1 })"].join('\n'),
  });
  const scan = scanProject(dir);
  assert.deepEqual(byId(scan.allFindings, 'contract_prop_missing'), []);
});

test('literalKeys reads JS, Lua, GDScript and Swift literals and refuses what it cannot be sure of', () => {
  assert.deepEqual(literalKeys('{ run_id: 1, "chapter": 2, depth }'), ['run_id', 'chapter', 'depth']);
  assert.deepEqual(literalKeys('{ run_id = 1, ["chapter"] = 2 }'), ['run_id', 'chapter']);
  assert.deepEqual(literalKeys('{"run_id": run, "depth": d}'), ['run_id', 'depth']);
  assert.deepEqual(literalKeys('["run_id": run, "depth": 0]'), ['run_id', 'depth']);
  assert.deepEqual(literalKeys('[:]'), []);
  assert.equal(literalKeys('[1, 2]'), null);
  assert.equal(literalKeys('{ ...rest, a: 1 }'), null);
  assert.equal(literalKeys('props'), null);
});

test('callPropKeys follows a Swift labelled props argument after a labelled name', () => {
  const code = ['Analytics.emitOnce(key: "intro", name: "progress_unlocked", props: ["content_id": "intro"])'];
  assert.deepEqual(callPropKeys(code, 0, code[0].indexOf('('), 1, 'swift'), ['content_id']);
});

test('a Swift dictionary at a call site is checked against the contract', (t) => {
  const dir = makeProject(t, {
    'ravensight.contract.json': JSON.stringify({ events: { choice_made: { required: ['decision_id', 'depth'] } } }),
    'Sources/Story.swift': 'func pick() {\n    Ravensight.track("choice_made", ["decision_id": id])\n}\n',
  });
  const scan = scanProject(dir);
  const f = byId(scan.allFindings, 'contract_prop_missing');
  assert.equal(f.length, 1);
  assert.equal(f[0].line, 2);
});

test('parseContract rejects broken contracts with a message naming the problem', () => {
  assert.throws(() => parseContract([]), ContractError);
  assert.throws(() => parseContract({ events: [] }), /events/);
  assert.throws(() => parseContract({ events: { a: { required: 'x' } } }), /required/);
  assert.throws(() => parseContract({ events: { a: { pairs_with: 'b' } } }), /no join/);
  assert.throws(() => parseContract({ events: {}, attempt_ids: ['decision_id'] }), /applies to nothing/);
  assert.throws(() => parseContract({ earned_once: { event: 'x' } }), /earned_once/);
  assert.throws(() => parseContract({ cumulative: [3] }), /cumulative\[0\]/);
  const ok = parseContract({ events: {}, attempt_ids: [{ prop: 'id', events: ['a'] }], extra: 1 });
  assert.deepEqual(ok.unknownKeys, ['extra']);
});

test('the CLI exits 2 for a broken contract, a missing --contract file, or --trace without a contract', async (t) => {
  const broken = makeProject(t, { 'ravensight.contract.json': '{ nope' });
  let r = await runCli([broken]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /not valid JSON/);

  const plain = makeProject(t, { 'src/game.js': "rs.track('a')\n" });
  r = await runCli([plain, '--contract', path.join(plain, 'missing.json')]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Could not read the contract/);

  fs.writeFileSync(path.join(plain, 't.jsonl'), '{}\n');
  r = await runCli([plain, '--trace', path.join(plain, 't.jsonl')]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--trace needs a contract/);

  r = await runCli([plain, '--trace']);
  assert.equal(r.code, 2);
});

test('--contract reads a contract from another path', async (t) => {
  const dir = makeProject(t, {
    ...JS_SDK,
    'contracts/game.json': JSON.stringify({ events: { level_start: {} } }),
    'src/game.js': "rs.track('other')\nrs.track('level_end')\n",
  });
  const r = await runCli([dir, '--json', '--contract', path.join(dir, 'contracts/game.json')]);
  const rep = JSON.parse(r.stdout);
  assert.ok(rep.contract);
  assert.ok(ids(rep.findings).includes('contract_unmatched'));
});

// Trace replay

test('each trace check reports its offending rows', () => {
  const contract = parseContract(CONTRACT);
  const events = TRACE.split('\n')
    .map((l, i) => ({ line: i + 1, e: parseTraceLine(l) }))
    .filter((x) => x.e)
    .map((x) => ({ line: x.line, ...x.e }));
  const out = replayTrace(contract, events);
  const byCheck = Object.fromEntries(out.map((f) => [f.id, f.rows.map((r) => r.line)]));
  assert.deepEqual(byCheck, {
    trace_cumulative_decreased: [7],
    trace_orphan_outcome: [4],
    trace_missing_attempt_id: [5],
    trace_missing_depth: [5],
    trace_repeated_earned: [9],
  });
  for (const f of out) assert.equal(f.severity, 'warning');
});

test('a loaded: true baseline is not a repeat, and repeats in different sessions are fine', () => {
  const contract = parseContract({ earned_once: { event: 'u', key: 'k' } });
  const ev = (line, session, props) => ({ line, event: 'u', session, props });
  const out = replayTrace(contract, [
    ev(1, 's1', { k: 'a' }),
    ev(2, 's2', { k: 'a' }),
    ev(3, 's2', { k: 'a', loaded: true }),
    ev(4, 's3', { k: 'b', loaded: 'true' }),
  ]);
  assert.deepEqual(out, []);
});

test('a cumulative prop with an explicit join, and a numeric string, are compared', () => {
  const contract = parseContract({ cumulative: [{ prop: 'secs', join: 'run' }] });
  const out = replayTrace(contract, [
    { line: 1, event: 'a', session: 's1', props: { run: 'r', secs: '10' } },
    { line: 2, event: 'b', session: 's2', props: { run: 'r', secs: 9 } },
    { line: 3, event: 'b', session: 's2', props: { run: 'other', secs: 1 } },
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].rows.map((r) => r.line), [2]);
});

test('a trace finding lists at most 10 rows and counts them all', () => {
  const contract = parseContract({ events: { e: { required: ['x'] } } });
  const events = Array.from({ length: 25 }, (_, i) => ({ line: i + 1, event: 'e', session: 's', props: {} }));
  const [f] = replayTrace(contract, events);
  assert.equal(f.count, 25);
  assert.equal(f.rows.length, 10);
});

test('parseTraceLine accepts both shapes and props as a JSON string', () => {
  assert.deepEqual(parseTraceLine('{"event_name":"a","session_id":"s","ts":"t","props":"{\\"x\\":1}"}'), {
    event: 'a',
    session: 's',
    ts: 't',
    props: { x: 1 },
  });
  assert.equal(parseTraceLine('{"event":"b","data":{"y":2},"timestamp":5}').event, 'b');
  assert.equal(parseTraceLine('{"props":{}}'), null);
  assert.equal(parseTraceLine('[1]'), null);
});

test('readTraceLines stops at the line limit and says the rest was ignored', (t) => {
  const dir = makeProject(t, { 'a.jsonl': 'l1\nl2\nl3\nl4\n', 'b.jsonl': 'l1\nl2\n\n\n', 'c.jsonl': 'x\ny' });
  assert.deepEqual(readTraceLines(path.join(dir, 'a.jsonl'), 2), { lines: ['l1', 'l2'], truncated: true });
  assert.deepEqual(readTraceLines(path.join(dir, 'b.jsonl'), 2), { lines: ['l1', 'l2'], truncated: false });
  assert.deepEqual(readTraceLines(path.join(dir, 'c.jsonl')), { lines: ['x', 'y'], truncated: false });
});

test('--trace prints the titled block, keeps the status, and --strict fails on a trace warning', async (t) => {
  const dir = project(t, { 'trace.jsonl': TRACE + '\n' });
  const trace = path.join(dir, 'trace.jsonl');
  let r = await runCli([dir, '--trace', trace]);
  assert.equal(r.code, 0);
  assert.ok(
    r.stdout.includes(
      'Trace replay (runtime check over the file you provided, not a proof of production behaviour)',
    ),
  );
  assert.match(r.stdout, /10 read, 9 events checked, 1 skipped/);
  assert.match(r.stdout, /trace_repeated_earned/);
  assert.match(r.stdout, /Trace:   5 findings/);

  r = await runCli([dir, '--trace', trace, '--json']);
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.trace.lines, 10);
  assert.equal(rep.trace.checked, 9);
  assert.equal(rep.trace.findings.length, 5);
  assert.ok(rep.trace.findings.every((f) => Array.isArray(f.rows)));
  assert.ok(!ids(rep.findings).some((id) => id.startsWith('trace_')));

  r = await runCli([dir, '--trace', trace, '--strict']);
  assert.equal(r.code, 1);
});

test('a clean trace passes --strict when the static scan passes', async (t) => {
  const dir = makeProject(t, {
    ...JS_SDK,
    'src/game.js': "const KEY = 'gt_live_" + 'a'.repeat(32) + "';\nrs.track('a', { x: 1 });\n",
    'ravensight.contract.json': JSON.stringify({ events: { a: { required: ['x'] } } }),
  });
  fs.writeFileSync(path.join(dir, 'clean.jsonl'), '{"event_name":"a","session_id":"s","props":{"x":1}}\n');
  const r = await runCli([dir, '--trace', path.join(dir, 'clean.jsonl'), '--strict']);
  assert.match(r.stdout, /No trace findings/);
  assert.equal(r.code, 0, r.stdout);
});

test('a trace over 50,000 lines is read to the limit with a note', async (t) => {
  const dir = makeProject(t, {
    ...JS_SDK,
    'src/game.js': "rs.track('a', { x: 1 })\n",
    'ravensight.contract.json': JSON.stringify({ events: { a: { required: ['x'] } } }),
  });
  const line = '{"event_name":"a","session_id":"s","props":{"x":1}}\n';
  const big = path.join(path.dirname(dir), path.basename(dir) + '-big.jsonl');
  fs.writeFileSync(big, line.repeat(MAX_TRACE_LINES + 5));
  t.after(() => fs.rmSync(big, { force: true }));
  const r = await runCli([dir, '--trace', big, '--json']);
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.trace.lines, MAX_TRACE_LINES);
  assert.equal(rep.trace.truncated, true);
  const pretty = await runCli([dir, '--trace', big]);
  assert.match(pretty.stdout, /Only the first 50000 lines were read/);
});
