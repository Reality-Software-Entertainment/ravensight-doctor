// File walking and engine detection for ravensight-doctor.
//
// The scanner is deliberately line based and dumb but honest: it prefers
// missing a clever case over reporting a false positive.

import fs from 'node:fs';
import path from 'node:path';

import { compileIgnore } from './ignore.js';

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
  'coverage',
  '.playwright-mcp',
  '.cache',
  '.next',
  '.nuxt',
  '.turbo',
  '.vite',
  '.svelte-kit',
  'tmp',
]);

// File extensions that are never read: images, fonts, audio, video,
// archives, compiled output, source maps, coverage and logs. Matched on the
// lowercased basename, so a double extension like .min.js works.
const SKIP_EXTENSIONS = [
  // images
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.icns', '.tga', '.tif', '.tiff',
  '.psd', '.exr', '.hdr', '.dds', '.ktx', '.ktx2', '.astc', '.avif', '.heic', '.svg',
  // fonts
  '.ttf', '.otf', '.woff', '.woff2', '.eot', '.fnt',
  // audio
  '.wav', '.mp3', '.ogg', '.oga', '.flac', '.aac', '.m4a', '.opus', '.wem', '.bank', '.mid', '.midi',
  // video
  '.mp4', '.m4v', '.mov', '.webm', '.avi', '.mkv', '.ogv', '.wmv',
  // archives and packages
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.pck', '.jar', '.apk', '.aab', '.ipa',
  '.unitypackage', '.dmg', '.iso',
  // compiled
  '.exe', '.dll', '.so', '.dylib', '.o', '.obj', '.a', '.lib', '.class', '.pyc', '.wasm', '.pdb',
  '.bin', '.res', '.scn', '.ctex', '.stex',
  // generated text
  '.map', '.lcov', '.min.js', '.min.css', '.log',
];

// Lockfiles and generated manifests: large, machine written, never
// integration code.
const SKIP_BASENAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'composer.lock',
  'Podfile.lock',
  'Package.resolved',
  'go.sum',
  'packages.lock.json',
  'lcov.info',
]);

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
const DEFAULT_CACHE_BYTES = 32 * 1024 * 1024; // 32MB
const BINARY_SNIFF_BYTES = 8000;

/** Is this file skipped by name alone, before it is ever opened? */
export function isSkippedFile(name) {
  if (SKIP_BASENAMES.has(name)) return true;
  const lower = name.toLowerCase();
  return SKIP_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Build the ignore predicate for a scan: the root .gitignore (unless
 * gitignore is false) plus any extra patterns.
 */
function buildIgnore(root, { ignore = [], gitignore = true } = {}) {
  const lines = [...ignore];
  if (gitignore) {
    try {
      lines.push(...fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/));
    } catch {
      // no .gitignore
    }
  }
  return compileIgnore(lines);
}

/**
 * Walk a project tree and return the scannable files as
 * [{ rel, size }] with forward slash relative paths, sorted.
 * Skips SKIP_DIRS, skipped extensions and lockfiles, anything matched by
 * the root .gitignore or the ignore option, symlinks, and files over 2MB.
 *
 * opts = { ignore: string[], gitignore: boolean (default true) }
 */
export function walkFiles(root, opts = {}) {
  const ignored = buildIgnore(root, opts);
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
        if (ignored(childRel, true)) continue;
        stack.push(childRel);
      } else if (entry.isFile()) {
        if (isSkippedFile(entry.name)) continue;
        if (ignored(childRel, false)) continue;
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
 * files (a NUL byte in the first 8000 bytes counts as binary). Only the
 * first 8000 bytes of a binary file are ever read.
 */
export function readText(root, rel) {
  let fd;
  try {
    fd = fs.openSync(path.join(root, rel), 'r');
    const head = Buffer.alloc(BINARY_SNIFF_BYTES);
    const n = fs.readSync(fd, head, 0, BINARY_SNIFF_BYTES, 0);
    if (head.subarray(0, n).includes(0)) return null;
    const size = fs.fstatSync(fd).size;
    if (size <= n) return head.subarray(0, n).toString('utf8');
    const rest = Buffer.alloc(size - n);
    let off = 0;
    while (off < rest.length) {
      const got = fs.readSync(fd, rest, off, rest.length - off, n + off);
      if (got === 0) break;
      off += got;
    }
    return Buffer.concat([head.subarray(0, n), rest.subarray(0, off)]).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

/**
 * A read function (rel) => text | null with a bounded cache, shared by
 * engine detection, SDK detection and the checks so each file is read from
 * disk once. Past maxBytes of cached text, files are read but not kept.
 * read.stats = { diskReads, hits, cachedBytes }.
 */
export function createReader(root, { maxBytes = DEFAULT_CACHE_BYTES } = {}) {
  const cache = new Map();
  const stats = { diskReads: 0, hits: 0, cachedBytes: 0 };
  const read = (rel) => {
    if (cache.has(rel)) {
      stats.hits++;
      return cache.get(rel);
    }
    stats.diskReads++;
    const text = readText(root, rel);
    const cost = text == null ? 0 : Buffer.byteLength(text);
    if (stats.cachedBytes + cost <= maxBytes) {
      cache.set(rel, text);
      stats.cachedBytes += cost;
    }
    return text;
  };
  read.stats = stats;
  return read;
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
