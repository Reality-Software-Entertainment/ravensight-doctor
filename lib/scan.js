// File walking and engine detection for ravensight-doctor.
//
// The scanner is deliberately line based and dumb but honest: it prefers
// missing a clever case over reporting a false positive.

import fs from 'node:fs';
import path from 'node:path';

// Directories that are never scanned, at any depth.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.import',
  '.godot',
  'Library',
  'Intermediate',
  'DerivedData',
  'build',
  'dist',
]);

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB

/**
 * Walk a project tree and return the scannable files as
 * [{ rel, size }] with forward slash relative paths, sorted.
 * Skips SKIP_DIRS, symlinks, and files over 2MB.
 */
export function walkFiles(root) {
  const files = [];
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop();
    const abs = rel === '' ? root : path.join(root, rel);
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(childRel);
      } else if (entry.isFile()) {
        let size;
        try {
          size = fs.statSync(path.join(root, childRel)).size;
        } catch {
          continue;
        }
        if (size > MAX_FILE_SIZE) continue;
        files.push({ rel: childRel, size });
      }
    }
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return files;
}

/**
 * Read a file as UTF-8 text. Returns null for unreadable or binary
 * files (a NUL byte in the first 8000 bytes counts as binary).
 */
export function readText(root, rel) {
  let buf;
  try {
    buf = fs.readFileSync(path.join(root, rel));
  } catch {
    return null;
  }
  if (buf.subarray(0, 8000).includes(0)) return null;
  return buf.toString('utf8');
}

function isDir(root, name) {
  try {
    return fs.statSync(path.join(root, name)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Detect the engine of the project at root. First match wins, in this
 * order: godot, unreal, unity, ios, android, javascript, odin, cpp,
 * then custom when nothing matches. The whole tree is scanned for
 * checks regardless of which engine is reported.
 *
 * files is the walkFiles() output; read is (rel) => text | null.
 */
export function detectEngine(root, files, read) {
  const rootFiles = files.filter((f) => !f.rel.includes('/')).map((f) => f.rel);

  if (rootFiles.includes('project.godot')) return 'godot';
  if (rootFiles.some((n) => n.endsWith('.uproject'))) return 'unreal';
  if (isDir(root, 'Assets') && isDir(root, 'ProjectSettings')) return 'unity';
  if (rootFiles.includes('Package.swift')) {
    const text = read('Package.swift') || '';
    if (/ravensight/i.test(text)) return 'ios';
  }
  if (rootFiles.includes('Podfile')) return 'ios';
  for (const f of files) {
    if (!/(^|\/)build\.gradle(\.kts)?$/.test(f.rel)) continue;
    const text = read(f.rel) || '';
    if (/com\.android\.(application|library)|(^|\W)android\s*\{/m.test(text)) {
      return 'android';
    }
  }
  if (rootFiles.includes('package.json')) return 'javascript';
  if (files.some((f) => f.rel.endsWith('.odin'))) return 'odin';
  if (rootFiles.includes('CMakeLists.txt')) {
    const text = read('CMakeLists.txt') || '';
    if (/ravensight/i.test(text)) return 'cpp';
  }
  return 'custom';
}
