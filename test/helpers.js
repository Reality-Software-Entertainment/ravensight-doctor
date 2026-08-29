import fs from 'node:fs';
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
