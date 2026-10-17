// --bundle <path>: check what ingest key a build that players receive carries.
//
// A native iOS or macOS game often keeps its publishable key in an ignored
// xcconfig that Xcode expands into the built Info.plist, so the source never
// holds it. Given a built .app (Info.plist at its root, or Contents/Info.plist
// for macOS) or an Info.plist itself, this reads the plist as text: an XML
// plist directly, a binary plist through `plutil -convert xml1 -o -` when
// plutil is available, and otherwise its raw bytes (a binary plist stores an
// ASCII string such as a key as plain bytes).
//
// Every other file in the build is read too: a web build directory, a .love
// or .zip (each member, stored or deflated, one archive inside another
// included), an executable, a .pck or a .wasm. Text is matched with the key
// boundary the source scan uses; a binary file (a NUL in its first 8000
// bytes) takes exactly the key's length, since compiled string tables run
// literals together with no separator.
//
// A gt_live_ key in a build players receive is the error live_key_in_bundle:
// a shipped build should carry a public key (gt_pub_). A gt_test_ key is the
// warning test_key_in_bundle. Only the kind prefix and the first four
// characters after it are ever printed, never a whole key.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import { finding } from './checks.js';
import { printable } from './printable.js';

/** A --bundle path that cannot be used. */
export class BundleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BundleError';
  }
}

const MAX_PLIST_BYTES = 8 * 1024 * 1024;

/** Convert a binary plist to XML text with plutil, or null when that is not possible. */
export function plutilXml(file) {
  try {
    return execFileSync('plutil', ['-convert', 'xml1', '-o', '-', file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: MAX_PLIST_BYTES * 2,
      timeout: 10_000,
    });
  } catch {
    return null;
  }
}

/** The key kinds a build can carry, by prefix. Each is the prefix and 32 base64url characters. */
export const KEY_PREFIXES = { live: 'gt_live_', public: 'gt_pub_', test: 'gt_test_' };
const KIND_OF = { live: 'live', pub: 'public', test: 'test' };
const SECRET_LEN = 32;
// Text: the source scan's boundary, so a longer token is not a key.
const TEXT_KEY_RE = /gt_(live|pub|test)_[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])/g;
// Binary: exactly the key's length, since string tables have no separators.
const BINARY_KEY_RE = /gt_(live|pub|test)_[A-Za-z0-9_-]{32}/g;
const BINARY_SNIFF_BYTES = 8000;
const CHUNK_BYTES = 8 * 1024 * 1024;
const OVERLAP_BYTES = 64;
const MAX_MEMBER_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_DEPTH = 3;
const MAX_FILES = 50_000;

/** The printable form of a key: its kind prefix and four characters, never the whole key. */
export function keyHint(key) {
  const m = /^gt_(?:live|pub|test)_/.exec(key);
  const prefix = m ? m[0] : '';
  return prefix + key.slice(prefix.length, prefix.length + 4) + '...';
}

/**
 * The ingest key shaped ASCII strings of a binary plist, read without
 * plutil: an ASCII string object is the marker 0x5F, an int marker (0x10
 * with one length byte or 0x11 with two) and the bytes, so a string is taken
 * only when its stored length is exactly that of a key. Returns them joined
 * by newlines.
 */
export function rawBinaryStrings(buf) {
  const found = [];
  for (const prefix of Object.values(KEY_PREFIXES)) {
    const needle = Buffer.from(prefix, 'latin1');
    const len = prefix.length + SECRET_LEN;
    for (let i = buf.indexOf(needle); i !== -1; i = buf.indexOf(needle, i + 1)) {
      const one = i >= 3 && buf[i - 3] === 0x5f && buf[i - 2] === 0x10 && buf[i - 1] === len;
      const two = i >= 4 && buf[i - 4] === 0x5f && buf[i - 3] === 0x11 && buf.readUInt16BE(i - 2) === len;
      if (one || two) found.push(buf.subarray(i, i + len).toString('latin1'));
    }
  }
  return found.join('\n');
}

/** Is this buffer binary: a NUL in its first 8000 bytes. */
function isBinary(buf) {
  return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/** Every key shaped string in text, as [kind, key] pairs. */
function keysIn(text, binary) {
  const out = [];
  for (const m of text.matchAll(new RegExp((binary ? BINARY_KEY_RE : TEXT_KEY_RE).source, 'g'))) {
    out.push([KIND_OF[m[1]], m[0]]);
  }
  return out;
}

/** A positional reader over a file descriptor or a buffer. */
function fdReader(fd, size) {
  return {
    size,
    read(offset, length) {
      const len = Math.max(0, Math.min(length, size - offset));
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const n = fs.readSync(fd, buf, got, len - got, offset + got);
        if (n === 0) break;
        got += n;
      }
      return got === len ? buf : buf.subarray(0, got);
    },
  };
}

function bufferReader(buf) {
  return { size: buf.length, read: (offset, length) => buf.subarray(offset, offset + length) };
}

/**
 * The members of a zip (a .love, .zip, .apk, .ipa, or a fused executable
 * with a zip appended), as [{ name, method, compSize, size, dataOffset,
 * encrypted }], or null when this is not a readable zip. Offsets are
 * corrected for data before the archive, which is how a fused LOVE
 * executable is laid out. ZIP64 archives are not read (null).
 */
export function zipEntries(reader) {
  const size = reader.size;
  if (size < 22) return null;
  const tailLen = Math.min(size, 22 + 0xffff);
  const tail = reader.read(size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return null;
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return null;
  const eocdPos = size - tailLen + eocd;
  const cdPos = eocdPos - cdSize;
  if (cdPos < 0) return null;
  const delta = cdPos - cdOffset;
  if (delta < 0) return null;
  const cd = reader.read(cdPos, cdSize);
  const entries = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) return null;
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const compSize = cd.readUInt32LE(p + 20);
    const uncompSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOffset = cd.readUInt32LE(p + 42) + delta;
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const local = reader.read(localOffset, 30);
    if (local.length < 30 || local.readUInt32LE(0) !== 0x04034b50) return null;
    const dataOffset = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    entries.push({ name, method, compSize, size: uncompSize, dataOffset, encrypted: Boolean(flags & 1) });
  }
  return entries;
}

/** A member's bytes, or null when it cannot be read (encrypted, an unknown method, too large). */
function memberBytes(reader, e) {
  if (e.encrypted || e.size > MAX_MEMBER_BYTES || e.compSize > MAX_MEMBER_BYTES) return null;
  const raw = reader.read(e.dataOffset, e.compSize);
  if (e.method === 0) return raw;
  if (e.method === 8) {
    try {
      return zlib.inflateRawSync(raw, { maxOutputLength: MAX_MEMBER_BYTES });
    } catch {
      return null;
    }
  }
  return null;
}

/** A label that is safe to print and to put in a finding. */
function safeLabel(s) {
  return printable(s, 280);
}

/**
 * Collect the keys in a bundle path. Returns { hits: Map(label -> [kind,
 * key][]), files, unreadable, plist } where plist is the Info.plist result
 * ({ file, format, unexpanded }) when the path is a plist or an .app with one.
 */
export function collectKeys(p, { convert = plutilXml } = {}) {
  let stat;
  try {
    stat = fs.statSync(p);
  } catch {
    throw new BundleError(`--bundle: ${p} does not exist.`);
  }
  const state = { hits: new Map(), files: 0, unreadable: 0, plist: null };
  const add = (label, pairs) => {
    if (pairs.length === 0) return;
    const list = state.hits.get(label) || [];
    for (const pair of pairs) if (!list.some(([, k]) => k === pair[1])) list.push(pair);
    state.hits.set(label, list);
  };
  const labelOf = (file) => path.relative(process.cwd(), file) || file;

  const scanBuffer = (label, buf, depth) => {
    if (depth < MAX_ARCHIVE_DEPTH) {
      const entries = zipEntries(bufferReader(buf));
      if (entries) {
        scanArchive(label, bufferReader(buf), entries, depth);
        return;
      }
    }
    add(label, keysIn(buf.toString('latin1'), isBinary(buf)));
  };

  const scanArchive = (label, reader, entries, depth) => {
    for (const e of entries) {
      const bytes = memberBytes(reader, e);
      if (bytes === null) {
        state.unreadable++;
        continue;
      }
      scanBuffer(`${label}!/${safeLabel(e.name)}`, bytes, depth + 1);
    }
  };

  const scanPlist = (file, useConvert = true) => {
    const label = labelOf(file);
    let buf;
    try {
      const size = fs.statSync(file).size;
      if (size > MAX_PLIST_BYTES) throw new BundleError(`--bundle: ${file} is larger than 8 MB, not an Info.plist.`);
      buf = fs.readFileSync(file);
    } catch (err) {
      if (err instanceof BundleError) throw err;
      throw new BundleError(`--bundle: could not read ${file}: ${err.message}`);
    }
    let text;
    let format = 'xml';
    if (buf.subarray(0, 6).toString('latin1') === 'bplist') {
      const xml = useConvert ? convert(file) : null;
      if (xml != null) {
        text = xml;
        format = 'binary';
      } else {
        text = rawBinaryStrings(buf);
        format = 'binary-raw';
      }
    } else {
      text = buf.toString('utf8');
    }
    state.files++;
    add(label, keysIn(text, false));
    return { file: label, format, unexpanded: /\$\([A-Za-z_][\w]*\)/.test(text) };
  };

  const scanFile = (file) => {
    state.files++;
    const label = labelOf(file);
    let fd;
    try {
      fd = fs.openSync(file, 'r');
    } catch {
      state.unreadable++;
      return;
    }
    try {
      const reader = fdReader(fd, fs.fstatSync(fd).size);
      const entries = zipEntries(reader);
      if (entries) {
        scanArchive(label, reader, entries, 0);
        return;
      }
      const binary = isBinary(reader.read(0, BINARY_SNIFF_BYTES));
      const pairs = [];
      for (let off = 0; off < reader.size; off += CHUNK_BYTES) {
        const chunk = reader.read(off, CHUNK_BYTES + OVERLAP_BYTES);
        pairs.push(...keysIn(chunk.toString('latin1'), binary));
        if (off + chunk.length >= reader.size) break;
      }
      add(label, pairs);
    } catch {
      state.unreadable++;
    } finally {
      fs.closeSync(fd);
    }
  };

  const isPlistFile = (file) => path.basename(file) === 'Info.plist' || file.endsWith('.plist');

  if (stat.isFile()) {
    if (isPlistFile(p)) state.plist = scanPlist(p);
    else scanFile(p);
    return state;
  }
  if (!stat.isDirectory()) throw new BundleError(`--bundle: ${p} is not a file or a directory.`);
  let plistFile = null;
  for (const rel of ['Info.plist', 'Contents/Info.plist']) {
    const candidate = path.join(p, rel);
    if (fs.existsSync(candidate)) {
      plistFile = path.resolve(candidate);
      state.plist = scanPlist(candidate);
      break;
    }
  }
  const stack = [p];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      state.unreadable++;
      continue;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) stack.push(abs);
      else if (ent.isFile()) {
        if (plistFile && path.resolve(abs) === plistFile) continue;
        if (state.files >= MAX_FILES) {
          state.unreadable++;
          continue;
        }
        if (isPlistFile(abs)) {
          // Another plist (a framework's, say): read from its raw bytes, no plutil
          // run per file, without changing the result's plist.
          try {
            scanPlist(abs, false);
          } catch {
            state.unreadable++;
          }
        } else scanFile(abs);
      }
    }
  }
  if (state.files === 0) throw new BundleError(`--bundle: ${p} has no files to check.`);
  return state;
}


function kindsSentence(kinds) {
  const names = [];
  if (kinds.live) names.push('a gt_live_ key');
  if (kinds.public) names.push('a gt_pub_ public key');
  return names.join(' and ');
}

/**
 * Check a bundle: a built .app, an Info.plist, a web build directory, a
 * .love or .zip, or any single built file. Returns { file, keyPresent,
 * format, filesScanned, keys: { live, public, test }, findings, finding }
 * (plus a non enumerable key) where format is xml, binary (converted with
 * plutil) or binary-raw for a plist or an .app with one, and otherwise
 * directory, archive or file. finding is bundle_key_present (info, a
 * gt_live_ or gt_pub_ key is there) or bundle_key_missing (warning);
 * findings adds live_key_in_bundle (error) and test_key_in_bundle (warning)
 * per file. convert is the binary plist converter (plutilXml by default).
 */
export function checkBundle(p, { convert = plutilXml } = {}) {
  const state = collectKeys(p, { convert });
  const label = path.relative(process.cwd(), p) || p;
  const distinct = { live: new Set(), public: new Set(), test: new Set() };
  const findings = [];
  for (const [where, pairs] of state.hits) {
    for (const [kind, key] of pairs) distinct[kind].add(key);
    const live = pairs.filter(([k]) => k === 'live').map(([, key]) => keyHint(key));
    const test = pairs.filter(([k]) => k === 'test').map(([, key]) => keyHint(key));
    if (live.length > 0) {
      findings.push(
        finding(
          'live_key_in_bundle',
          'error',
          'A gt_live_ key ships in a build players receive',
          `${where} carries ${live.length === 1 ? 'the gt_live_ key' : 'the gt_live_ keys'} ${live.join(', ')} (not printed in full). ` +
            'Anyone with this build can read it, so a shipped build should carry a public key (gt_pub_), ' +
            'which only sends the events you list and can be paused or revoked: ' +
            'https://ravensight.io/docs/#public-builds',
          where,
        ),
      );
    }
    if (test.length > 0) {
      findings.push(
        finding(
          'test_key_in_bundle',
          'warning',
          'A gt_test_ key ships in a build players receive',
          `${where} carries ${test.length === 1 ? 'the gt_test_ key' : 'the gt_test_ keys'} ${test.join(', ')} (not printed in full). ` +
            'A test key does not belong in a build players receive; ship a public key (gt_pub_): ' +
            'https://ravensight.io/docs/#public-builds',
          where,
        ),
      );
    }
  }
  const kinds = { live: distinct.live.size > 0, public: distinct.public.size > 0 };
  const keyPresent = kinds.live || kinds.public;
  const unexpanded = Boolean(state.plist && state.plist.unexpanded);
  const skipped =
    state.unreadable > 0
      ? ` ${state.unreadable} ${state.unreadable === 1 ? 'file or archive member' : 'files or archive members'} could not be read (encrypted, ZIP64, an unknown compression method or over 256 MB).`
      : '';
  const f = keyPresent
    ? finding(
        'bundle_key_present',
        'info',
        'The built bundle carries an ingest key',
        `${label} holds ${kindsSentence(kinds)} of the right shape (not printed). This confirms the build injects a ` +
          'key; --live with a gt_live_ key confirms which game and environment it belongs to.' +
          skipped,
      )
    : finding(
        'bundle_key_missing',
        'warning',
        'The built bundle has no ingest key',
        `${label} holds no gt_live_ or gt_pub_ ingest key (the prefix and 32 letters, digits, _ or -), so this build has ` +
          'nothing to authenticate with and no events will arrive.' +
          (unexpanded
            ? ' It still has unexpanded $(...) build settings, so this looks like the source Info.plist rather ' +
              'than the one inside the built .app, or the xcconfig that defines the setting was not applied.'
            : state.plist
              ? ' Check that the xcconfig or build setting that carries the key is applied to this configuration.'
              : ' Check that the build step that writes the key ran for this build.') +
          skipped,
      );
  let format;
  if (state.plist) format = state.plist.format;
  else if (fs.statSync(p).isDirectory()) format = 'directory';
  else format = isArchive(p) ? 'archive' : 'file';
  const result = {
    file: label,
    keyPresent,
    format,
    filesScanned: state.files,
    keys: { live: distinct.live.size, public: distinct.public.size, test: distinct.test.size },
    findings: [...findings, f],
    finding: f,
  };
  // The gt_live_ key itself, for --live and --report only: not enumerable,
  // so it never reaches JSON output or a log of the result. A public key is
  // refused by the doctor's ping and report, so it is never offered.
  const first = distinct.live.values().next();
  Object.defineProperty(result, 'key', { value: first.done ? null : first.value, enumerable: false });
  return result;
}

function isArchive(p) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    return zipEntries(fdReader(fd, fs.fstatSync(fd).size)) !== null;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
