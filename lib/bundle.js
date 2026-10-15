// --bundle <path>: confirm a built bundle carries an ingest key.
//
// A native iOS or macOS game often keeps its publishable key in an ignored
// xcconfig that Xcode expands into the built Info.plist, so the source never
// holds it. Given a built .app (Info.plist at its root, or Contents/Info.plist
// for macOS) or an Info.plist itself, this reads the plist as text: an XML
// plist directly, a binary plist through `plutil -convert xml1 -o -` when
// plutil is available, and otherwise its raw bytes (a binary plist stores an
// ASCII string such as a key as plain bytes). The key is never printed or
// returned, only whether one of the right shape is there.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { finding, INGEST_KEY_RE } from './checks.js';

/** A --bundle path that cannot be used. */
export class BundleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BundleError';
  }
}

const MAX_PLIST_BYTES = 8 * 1024 * 1024;

/** The Info.plist for a bundle path, or throws BundleError. */
export function plistPath(p) {
  let stat;
  try {
    stat = fs.statSync(p);
  } catch {
    throw new BundleError(`--bundle: ${p} does not exist.`);
  }
  if (stat.isFile()) return p;
  for (const rel of ['Info.plist', 'Contents/Info.plist']) {
    const candidate = path.join(p, rel);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new BundleError(`--bundle: no Info.plist in ${p} (looked for Info.plist and Contents/Info.plist).`);
}

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

const KEY_LEN = 'gt_live_'.length + 32;

/**
 * The ingest key shaped ASCII strings of a binary plist, read without
 * plutil: an ASCII string object is the marker 0x5F, an int marker (0x10
 * with one length byte or 0x11 with two) and the bytes, so a string is taken
 * only when its stored length is exactly that of a key. Returns them joined
 * by newlines.
 */
export function rawBinaryStrings(buf) {
  const found = [];
  const needle = Buffer.from('gt_live_', 'latin1');
  for (let i = buf.indexOf(needle); i !== -1; i = buf.indexOf(needle, i + 1)) {
    const one = i >= 3 && buf[i - 3] === 0x5f && buf[i - 2] === 0x10 && buf[i - 1] === KEY_LEN;
    const two = i >= 4 && buf[i - 4] === 0x5f && buf[i - 3] === 0x11 && buf.readUInt16BE(i - 2) === KEY_LEN;
    if (one || two) found.push(buf.subarray(i, i + KEY_LEN).toString('latin1'));
  }
  return found.join('\n');
}

/**
 * Check a bundle. Returns { file, keyPresent, format, finding } (plus a
 * non enumerable key) where
 * format is xml, binary (converted with plutil) or binary-raw, and finding
 * is bundle_key_present (info) or bundle_key_missing (warning). convert is
 * the binary plist converter (plutilXml by default).
 */
export function checkBundle(p, { convert = plutilXml } = {}) {
  const file = plistPath(p);
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
    const xml = convert(file);
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
  const match = new RegExp(INGEST_KEY_RE.source).exec(text);
  const keyPresent = match !== null;
  const unexpanded = /\$\([A-Za-z_][\w]*\)/.test(text);
  const label = path.relative(process.cwd(), file) || file;
  const f = keyPresent
    ? finding(
        'bundle_key_present',
        'info',
        'The built bundle carries an ingest key',
        `${label} holds a gt_live_ ingest key of the right shape (not printed). This confirms the build injects a ` +
          'key; --live with that key confirms which game and environment it belongs to.',
      )
    : finding(
        'bundle_key_missing',
        'warning',
        'The built bundle has no ingest key',
        `${label} holds no gt_live_ ingest key (gt_live_ and 32 letters, digits, _ or -), so this build has ` +
          'nothing to authenticate with and no events will arrive.' +
          (unexpanded
            ? ' It still has unexpanded $(...) build settings, so this looks like the source Info.plist rather ' +
              'than the one inside the built .app, or the xcconfig that defines the setting was not applied.'
            : ' Check that the xcconfig or build setting that carries the key is applied to this configuration.'),
      );
  const result = { file: label, keyPresent, format, finding: f };
  // The key itself, for --live and --report only: not enumerable, so it never
  // reaches JSON output or a log of the result.
  Object.defineProperty(result, 'key', { value: match ? match[0] : null, enumerable: false });
  return result;
}
