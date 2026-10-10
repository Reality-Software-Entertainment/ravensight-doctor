import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, makeProject, runCli, startServer } from './helpers.js';

test('exit 0 on a project with warnings only', async () => {
  const { code, stdout } = await runCli([fixture('godot-project')]);
  assert.equal(code, 0);
  assert.ok(stdout.includes('Engine:  godot'));
  assert.ok(stdout.includes('event_name_cardinality'));
  assert.ok(stdout.includes('Status:  warn'));
});

test('exit 1 on a project with an error finding', async () => {
  const { code, stdout } = await runCli([fixture('js-project')]);
  assert.equal(code, 1);
  assert.ok(stdout.includes('event_name_too_long'));
  assert.ok(stdout.includes('Status:  fail'));
});

test('secret fixture fails and never prints the raw token', async () => {
  const { code, stdout, stderr } = await runCli([fixture('secret-project')]);
  assert.equal(code, 1);
  assert.ok(stdout.includes('wrong_key_type'));
  assert.ok(stdout.includes('gt_mcp_E...'));
  const all = stdout + stderr;
  assert.ok(!all.includes('gt_mcp_EXAMPLEEXAMPLEEXAMPLE0000'));
  assert.ok(!all.includes('sk_live_EXAMPLEFAKE0000000'));
  assert.ok(!all.includes('AKIAIOSFODNN7EXAMPLE'));
});

test('--json prints a contract shaped report', async () => {
  const { code, stdout } = await runCli(['--json', fixture('godot-project')]);
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.engine, 'godot');
  assert.match(report.doctorVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(report.summary.status, 'warn');
  assert.equal(typeof report.summary.errors, 'number');
  assert.equal(typeof report.summary.warnings, 'number');
  assert.ok(Array.isArray(report.findings));
  for (const f of report.findings) {
    assert.ok(['error', 'warning', 'info'].includes(f.severity));
    assert.equal(typeof f.id, 'string');
    assert.equal(typeof f.title, 'string');
    assert.equal(typeof f.detail, 'string');
  }
});

test('exit 2 on an unknown option', async () => {
  const { code, stderr } = await runCli(['--frobnicate']);
  assert.equal(code, 2);
  assert.ok(stderr.includes('Unknown option'));
});

test('exit 2 on a missing directory', async () => {
  const { code, stderr } = await runCli(['/definitely/not/a/real/path']);
  assert.equal(code, 2);
  assert.ok(stderr.includes('Not a directory'));
});

test('--help exits 0', async () => {
  const { code, stdout } = await runCli(['--help']);
  assert.equal(code, 0);
  assert.ok(stdout.includes('Usage: ravensight-doctor'));
});

test('--report posts the report with the given key', async () => {
  let received = null;
  let headers = null;
  const { server, url } = await startServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      received = { method: req.method, url: req.url, body: JSON.parse(body) };
      headers = req.headers;
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end('{"stored":true}');
    });
  });
  try {
    const { code, stderr } = await runCli([
      fixture('godot-project'),
      '--report',
      '--key',
      'gt_live_TESTKEY0000000000',
      '--api-url',
      url,
    ]);
    assert.equal(code, 0);
    assert.ok(stderr.includes('Report submitted'));
    assert.equal(received.method, 'POST');
    assert.equal(received.url, '/api/v1/doctor');
    assert.equal(headers['x-api-key'], 'gt_live_TESTKEY0000000000');
    assert.equal(headers['content-type'], 'application/json');
    assert.equal(received.body.engine, 'godot');
    assert.equal(received.body.summary.status, 'warn');
    assert.ok(Array.isArray(received.body.findings));
  } finally {
    server.close();
  }
});

test('--report falls back to the key found in the project', async () => {
  let headers = null;
  const { server, url } = await startServer((req, res) => {
    headers = req.headers;
    req.resume();
    req.on('end', () => {
      res.writeHead(201);
      res.end();
    });
  });
  try {
    const { code } = await runCli([fixture('godot-project'), '--report', '--api-url', url]);
    assert.equal(code, 0);
    assert.equal(headers['x-api-key'], 'gt_live_FIXTUREFAKE0000000000');
  } finally {
    server.close();
  }
});

test('--report with a rejected key exits 1 but still prints the report', async () => {
  const { server, url } = await startServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":"bad key"}');
    });
  });
  try {
    const { code, stdout, stderr } = await runCli([
      fixture('godot-project'),
      '--report',
      '--key',
      'gt_live_WRONGKEY000000000',
      '--api-url',
      url,
    ]);
    assert.equal(code, 1);
    assert.ok(stdout.includes('Status:  warn'));
    assert.ok(stderr.includes('rejected the ingest key'));
  } finally {
    server.close();
  }
});

test('--report network failure exits 1 with the local report intact', async () => {
  const { code, stdout, stderr } = await runCli([
    fixture('godot-project'),
    '--report',
    '--key',
    'gt_live_TESTKEY0000000000',
    '--api-url',
    'http://127.0.0.1:9',
  ]);
  assert.equal(code, 1);
  assert.ok(stdout.includes('Status:  warn'));
  assert.ok(stderr.includes('could not reach'));
});

test('--report with no key anywhere exits 1 with a clear message', async () => {
  const { code, stderr } = await runCli([fixture('secret-project'), '--report', '--api-url', 'http://127.0.0.1:9']);
  assert.equal(code, 1);
  assert.ok(stderr.includes('no ingest key'));
});

test('--ignore is repeatable and --no-gitignore scans ignored files', async (t) => {
  const dir = makeProject(t, {
    'project.godot': 'config_version=5\n',
    'addons/ravensight/Ravensight.gd': 'extends Node\nfunc track(n, d := {}):\n\treturn true\n',
    '.gitignore': 'private/\n',
    'private/a.txt': 'gt_mcp_FAKEFAKEFAKE0601\n',
    'vendor/a.txt': 'gt_mcp_FAKEFAKEFAKE0602\n',
    'third/a.txt': 'gt_mcp_FAKEFAKEFAKE0603\n',
  });
  const ignored = await runCli([dir, '--json', '--ignore', 'vendor', '--ignore', 'third/']);
  assert.equal(JSON.parse(ignored.stdout).findings.filter((f) => f.id === 'wrong_key_type').length, 0);
  const all = await runCli([dir, '--json', '--no-gitignore']);
  assert.equal(JSON.parse(all.stdout).findings.filter((f) => f.id === 'wrong_key_type').length, 3);
});

test('--ignore without a value is a usage error', async () => {
  const { code, stderr } = await runCli(['--ignore']);
  assert.equal(code, 2);
  assert.ok(stderr.includes('--ignore'));
});

test('a broken ravensight.config.json exits 2 and names the file', async (t) => {
  const dir = makeProject(t, { 'ravensight.config.json': '{ nope' });
  const { code, stderr } = await runCli([dir]);
  assert.equal(code, 2);
  assert.ok(stderr.includes('ravensight.config.json'));
});
