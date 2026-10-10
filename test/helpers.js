import fs from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
export const BIN = fileURLToPath(new URL('../bin/ravensight-doctor.js', import.meta.url));

export function fixture(name) {
  return path.join(FIXTURES, name);
}

/**
 * Create a throwaway project directory from a { relPath: content } map.
 * Registered for cleanup on the test context.
 */
export function makeProject(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-doctor-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function ids(findings) {
  return findings.map((f) => f.id);
}

export function byId(findings, id) {
  return findings.filter((f) => f.id === id);
}

/** Run the CLI in a child process with RAVENSIGHT_INGEST_KEY cleared. */
export function runCli(args, envExtra = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.RAVENSIGHT_INGEST_KEY;
    Object.assign(env, envExtra);
    const child = spawn(process.execPath, [BIN, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Start a local HTTP server on a free port. */
export function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}
