// Integration checks for ravensight-doctor.
//
// Every check produces findings of the shape
//   { id, severity: "error" | "warning" | "info", title, detail, file, line }
// with title, detail and file capped to the report API limits.
//
// The scanner is line based and conservative: it prefers missing a clever
// case over reporting a false positive.

import { stripComments, extOf } from './comments.js';
import { compilePathPattern } from './ignore.js';
import { wrapperScopes, isForwarded, handlerScopes, isHandlerForwarded } from './wrappers.js';

const TITLE_MAX = 200;
const DETAIL_MAX = 1000;
const FILE_MAX = 300;
const EVENT_NAME_MAX = 200;
const PAYLOAD_MAX = 8 * 1024; // server caps event data at 8KB serialized
const MAX_FINDINGS = 100;
const MAX_LISTED_UNRESOLVED = 20;
// At or above this share of unresolved calls the status is inconclusive.
export const UNRESOLVED_INCONCLUSIVE_SHARE = 0.25;

// Built in track call forms. Each regex is global so every call on a line
// is found. Member calls require the identifier right before ".track(" to be
// exactly rs, ravensight or Ravensight; any dotted chain may come before it
// (this.rs.track( and window.rs.track( match, analytics.track( and
// myrs.track( do not). argIndex says which argument holds the event name
// (Odin passes the client first).
const BUILTIN_FORMS = [
  { name: 'rs.track', re: /(?<![\w$])rs\.track\(/g, argIndex: 0 },
  { name: 'ravensight.track', re: /(?<![\w$])ravensight\.track\(/g, argIndex: 0 },
  { name: 'Ravensight.track', re: /(?<![\w$])Ravensight\.track\(/g, argIndex: 0 },
  { name: 'Ravensight.Track', re: /(?<![\w$])Ravensight\.Track\(/g, argIndex: 0 },
  { name: '->Track', re: /->Track\(/g, argIndex: 0 },
  { name: 'track(client, ...)', re: /(?<![.\w$])track\(client,/g, argIndex: 1 },
];

function escapeRe(s) {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/**
 * The track call forms for a scan: the built in forms, then each custom
 * spec { name, argIndex, source, paths? }, one form per name.
 *
 * A bare custom name (capture) matches only an unqualified call: no ".",
 * "?.", "::" or "->" right before the name, whitespace allowed, and in Lua
 * no ":" either. A name with a leading "*." (*.capture) matches the same
 * call on any receiver and never an unqualified one. A dotted name anchors
 * its first segment at an identifier boundary, so Analytics.logEvent
 * matches Game.Analytics.logEvent( but not MyAnalytics.logEvent(. A Lua
 * method name such as telemetry:track matches telemetry:track( and
 * telemetry.track( both.
 *
 * Specs that share a name become entries of one form, each with its own
 * argIndex and optional paths (see resolveEntry). Config specs come first;
 * a --track-fn spec whose name the config already has without paths is
 * dropped, as the config wins.
 *
 * Returns [{ name, re, qualifier, argIndex, source, entries }] where
 * qualifier is 'none' (bare), 'any' (*.) or null (no check), and each entry
 * is { argIndex, source, paths, matchers, calls, raw }.
 */
export function buildTrackPatterns(custom = []) {
  const forms = BUILTIN_FORMS.map((f) => ({
    ...f,
    re: new RegExp(f.re.source, 'g'),
    qualifier: null,
    source: 'builtin',
    entries: [newEntry(f.argIndex, 'builtin')],
  }));
  const byName = new Map(forms.map((f) => [f.name, f]));
  for (const spec of custom) {
    const source = spec.source || 'flag';
    const entry = newEntry(spec.argIndex ?? 0, source, spec.paths);
    const form = byName.get(spec.name);
    if (form) {
      if (form.source === 'builtin') continue;
      if (!entry.paths && form.entries.some((e) => !e.paths)) continue;
      form.entries.push(entry);
      continue;
    }
    const any = spec.name.startsWith('*.');
    const base = any ? spec.name.slice(2) : spec.name;
    const created = {
      name: spec.name,
      re: new RegExp('(?<![\\w$])' + base.split(':').map(escapeRe).join('[:.]') + '\\(', 'g'),
      qualifier: any ? 'any' : /[.:]/.test(base) ? null : 'none',
      argIndex: entry.argIndex,
      source,
      entries: [entry],
    };
    forms.push(created);
    byName.set(spec.name, created);
  }
  return forms;
}

function newEntry(argIndex, source, paths) {
  return {
    argIndex,
    source,
    paths: paths ? paths.slice() : null,
    matchers: paths ? paths.map(compilePathPattern) : null,
    calls: 0,
    raw: 0,
  };
}

/**
 * The entry of a form that applies to the file rel: of the entries with
 * paths, the one whose matching pattern is most specific (most characters
 * that are not wildcards or slashes; the earlier entry on a tie), else the
 * entry without paths, else null.
 */
export function resolveEntry(form, rel) {
  let best = null;
  let bestScore = -1;
  for (const e of form.entries) {
    if (!e.matchers) continue;
    for (const m of e.matchers) {
      if (m.specificity > bestScore && m.test(rel)) {
        best = e;
        bestScore = m.specificity;
      }
    }
  }
  return best || form.entries.find((e) => !e.matchers) || null;
}

/**
 * Is the name starting at start qualified by a receiver: a ".", "?." or
 * "::" right before it, whitespace allowed, or a "->" with the name right
 * after it ($this->capture(; a spaced "x -> capture(" is a Kotlin or Java
 * lambda or when arrow, not a receiver)? In Lua a single ":" (obj:track)
 * counts too; elsewhere a lone ":" is a ternary arm or an object key, and
 * ".." (Lua concatenation) or "..." (spread) is not a receiver.
 */
export function isQualified(line, start, lua = false) {
  let k = start - 1;
  while (k >= 0 && (line[k] === ' ' || line[k] === '\t')) k--;
  if (k < 0) return false;
  const c = line[k];
  if (c === '.') return line[k - 1] !== '.';
  if (c === ':') return line[k - 1] === ':' || lua;
  return c === '>' && line[k - 1] === '-' && k === start - 1;
}

// Text right before a match that marks a definition, not a call. The
// receiver part covers Lua's function x.track( and function x:track(.
const DEF_BEFORE_RE = /(?:\b(?:function|func|def|fn|fun|proc|sub|void)\s+(?:[\w$]+[.:])*|::\s*proc\s*)$/;

// Credentials that must never ship inside a game build.
const WRONG_KEY_PATTERNS = [
  { re: /gt_mcp_[A-Za-z0-9_]{8,}/g, kind: 'a Ravensight MCP personal access token' },
  { re: /\b(?:sk|rk)_live_[A-Za-z0-9]{8,}/g, kind: 'a Stripe live secret key' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, kind: 'an AWS access key id' },
];

// A real ingest key is gt_live_ plus exactly 32 characters of
// [A-Za-z0-9_-]; a longer run is not a key.
export const INGEST_KEY_RE = /gt_live_[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])/g;

// Keys in these directories, or in *.test.* and *.spec.* files, are test
// keys: reported, but they never stand in for the game's real key.
// Directory names match case insensitively (Unity's Assets/Tests counts).
const TEST_DIRS = new Set(['__tests__', '__fixtures__', '__mocks__', 'fixtures', 'test', 'tests', 'spec', 'specs']);
const TEST_FILE_RE = /\.(?:test|spec)\./i;

/** Is rel (a forward slash path relative to the scan root) a test path? */
export function isTestPath(rel) {
  const parts = rel.split('/');
  const base = parts.pop();
  return parts.some((d) => TEST_DIRS.has(d.toLowerCase())) || TEST_FILE_RE.test(base);
}

// Track call scope. Test paths (isTestPath) and files under these docs
// directories (basename match at any depth, any case) are left out of the
// track call inventory by default: test paths come back with includeTests,
// docs with includeDocs. Key scanning always covers them. HTML pages are
// not docs files: their <script> elements are scanned (see comments.js),
// unless they sit under one of the docs directories.
const CALL_DOC_DIRS = new Set(['docs', 'doc', 'examples', 'example']);
const DOC_FILE_RE = /\.(?:md|mdx|rst|txt)$/i;
const HTML_FILE_RE = /\.html?$/i;
// How many left out HTML pages the inventory names.
const HTML_LEFT_OUT_MAX = 20;
// A vendored copy of the SDK (lib/ravensight/, vendor/ravensight/,
// addons/ravensight/) is never part of the inventory.
const VENDORED_SDK_DIR = 'ravensight';

/**
 * Why rel is left out of the track call scan: 'vendored', 'tests' or
 * 'docs', or null when it is scanned. Test paths and docs come back with
 * includeTests and includeDocs; a vendored SDK never does. Key hygiene
 * ignores this and scans everything.
 */
export function callScopeExclusion(rel, { includeTests = false, includeDocs = false } = {}) {
  const parts = rel.split('/');
  const base = parts.pop();
  const dirs = parts.map((d) => d.toLowerCase());
  if (dirs.includes(VENDORED_SDK_DIR) || SDK_FILE_RE.test(base)) return 'vendored';
  if (!includeTests && isTestPath(rel)) return 'tests';
  if (!includeDocs && (DOC_FILE_RE.test(base) || dirs.some((d) => CALL_DOC_DIRS.has(d)))) return 'docs';
  return null;
}

/** Is rel scanned for track calls? See callScopeExclusion. */
export function inCallScope(rel, opts = {}) {
  return callScopeExclusion(rel, opts) === null;
}

// File basenames that are the SDK itself; their bodies (docs, examples,
// internal calls) are excluded from track call analysis so SDK internals
// do not trip integration findings. Key scanning still covers them.
const SDK_FILE_RE = /^ravensight[\w.-]*\.(gd|lua|cs|js|mjs|cjs|ts|swift|kt|java|odin|h|hpp|c|cpp|uplugin)$/i;

function clip(s, max) {
  s = String(s ?? '');
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

function finding(id, severity, title, detail, file, line) {
  const f = { id, severity, title: clip(title, TITLE_MAX), detail: clip(detail, DETAIL_MAX) };
  if (file != null) f.file = clip(file, FILE_MAX);
  if (line != null) f.line = line;
  return f;
}

function mask(secret) {
  return secret.slice(0, 8) + '...';
}

function basename(rel) {
  const i = rel.lastIndexOf('/');
  return i === -1 ? rel : rel.slice(i + 1);
}

/**
 * Extract the argument at argIndex from a call whose "(" sits at openIdx
 * in line. Line based on purpose: an argument that continues onto the
 * next line is simply not analyzed. Returns { expr, outside } where
 * outside is the argument text with string literal bodies removed, or
 * null when the argument is not present on this line.
 */
function extractArg(line, openIdx, argIndex) {
  let depth = 0;
  let inStr = null;
  let esc = false;
  let arg = 0;
  let expr = '';
  let outside = '';
  for (let k = openIdx + 1; k < line.length; k++) {
    const c = line[k];
    if (inStr) {
      if (arg === argIndex) expr += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c;
      if (arg === argIndex) expr += c;
      continue;
    }
    if (c === ')' && depth === 0) break;
    if (c === ',' && depth === 0) {
      arg++;
      if (arg > argIndex) break;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (arg === argIndex) {
      expr += c;
      outside += c;
    }
  }
  if (expr.trim() === '') return null;
  return { expr: expr.trim(), outside };
}

/**
 * First quoted string literal inside expr, or null.
 * Returns { quote, content, prefix } where prefix is the character
 * immediately before the opening quote ("" at start).
 */
function firstLiteral(expr) {
  const m = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/.exec(expr);
  if (!m) return null;
  const prefix = m.index > 0 ? expr[m.index - 1] : '';
  return { quote: m[1], content: m[2], prefix };
}

/**
 * The event name when the argument is exactly one plain string literal
 * (optionally wrapped as TEXT("...") or prefixed & or @), else null.
 * Interpolated, concatenated or variable names are null.
 */
function literalName(expr) {
  let e = expr.trim();
  const text = /^TEXT\(\s*([\s\S]*?)\s*\)$/.exec(e);
  if (text) e = text[1];
  if (e.startsWith('&') || e.startsWith('@')) e = e.slice(1);
  const m = /^(["'`])((?:\\.|(?!\1)[^\\])*)\1$/.exec(e);
  if (!m) return null;
  if (m[1] === '`' && m[2].includes('${')) return null;
  return m[2];
}

const LITERAL_RE = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

/**
 * The two event names of a two literal ternary, cond ? "a" : "b", or null.
 * Exactly one "?" and one ":" outside the string literals ("?." and "??"
 * and "::" do not count), so a nested ternary or a non literal arm is
 * null.
 */
function ternaryNames(expr) {
  // Blank the literal bodies so a "?" or ":" inside a string is ignored.
  const masked = expr.replace(LITERAL_RE, (m) => m[0] + '_'.repeat(m.length - 2) + m[m.length - 1]);
  const qs = [];
  const cs = [];
  for (let k = 0; k < masked.length; k++) {
    const c = masked[k];
    if (c === '?' && masked[k + 1] !== '.' && masked[k + 1] !== '?' && masked[k - 1] !== '?') qs.push(k);
    else if (c === ':' && masked[k + 1] !== ':' && masked[k - 1] !== ':') cs.push(k);
  }
  if (qs.length !== 1 || cs.length !== 1 || cs[0] < qs[0]) return null;
  if (expr.slice(0, qs[0]).trim() === '') return null;
  const a = literalName(expr.slice(qs[0] + 1, cs[0]));
  const b = literalName(expr.slice(cs[0] + 1));
  if (a === null || b === null) return null;
  return a === b ? [a] : [a, b];
}

/** Index of the ")" closing the call opened at openIdx, or -1 if not on this line. */
function closeParen(line, openIdx) {
  let depth = 0;
  let inStr = null;
  let esc = false;
  for (let k = openIdx; k < line.length; k++) {
    const c = line[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return k;
  }
  return -1;
}

/** Does the match at [start, openIdx] look like a function definition? */
function isDefinition(line, start, openIdx) {
  if (DEF_BEFORE_RE.test(line.slice(0, start))) return true;
  const close = closeParen(line, openIdx);
  if (close === -1) return false;
  // A method definition: name(args) { or name(args): Type {
  return /^\s*(?:\{|:\s*[\w<>[\]|,.? ]+\{)/.test(line.slice(close + 1));
}

/**
 * Measure the largest object or dictionary literal inside the call whose
 * "(" is at (startLine, openIdx). Follows the call across lines until its
 * closing ")" or a scan cap. Only braces inside the call's parentheses
 * count. Returns the literal's source length in characters, or 0.
 */
function measureInlinePayload(lines, startLine, openIdx) {
  let parenDepth = 0;
  let braceDepth = 0;
  let capturing = false;
  let len = 0;
  let best = 0;
  let inStr = null;
  let esc = false;
  let scannedChars = 0;
  const CHAR_CAP = 512 * 1024;
  for (let i = startLine; i < lines.length; i++) {
    const s = i === startLine ? lines[i].slice(openIdx) : lines[i];
    for (let k = 0; k < s.length; k++) {
      const c = s[k];
      scannedChars++;
      if (scannedChars > CHAR_CAP) return Math.max(best, capturing ? len : 0);
      if (capturing) len++;
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === inStr) inStr = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        inStr = c;
        continue;
      }
      if (c === '(') parenDepth++;
      else if (c === ')') {
        parenDepth--;
        if (parenDepth <= 0) return Math.max(best, 0);
      } else if (c === '{' && parenDepth >= 1) {
        if (!capturing) {
          capturing = true;
          len = 1;
        }
        braceDepth++;
      } else if (c === '}' && capturing) {
        braceDepth--;
        if (braceDepth === 0) {
          if (len > best) best = len;
          capturing = false;
        }
      }
    }
    if (capturing) len++; // count the newline
  }
  return best;
}

/** Does the engine ship a Ravensight SDK we can look for statically? */
function detectSdk(engine, files, read) {
  const names = files.map((f) => basename(f.rel));
  const hasName = (re) => names.some((n) => re.test(n));
  switch (engine) {
    case 'godot':
      return hasName(/^Ravensight\.gd$/);
    case 'javascript': {
      for (const f of files) {
        if (basename(f.rel) !== 'package.json') continue;
        const text = read(f.rel);
        if (!text) continue;
        let pkg;
        try {
          pkg = JSON.parse(text);
        } catch {
          continue;
        }
        const deps = {
          ...(pkg.dependencies || {}),
          ...(pkg.devDependencies || {}),
        };
        if (Object.keys(deps).some((k) => k.toLowerCase().includes('ravensight'))) return true;
      }
      return hasName(/^ravensight[\w.-]*\.(js|mjs|cjs|ts)$/i);
    }
    case 'unity': {
      if (hasName(/^Ravensight\.cs$/)) return true;
      for (const f of files) {
        if (!f.rel.endsWith('Packages/manifest.json')) continue;
        const text = read(f.rel) || '';
        if (/ravensight/i.test(text)) return true;
      }
      return false;
    }
    case 'unreal':
      return (
        files.some((f) => /(^|\/)Plugins\/[^/]*Ravensight[^/]*\//i.test(f.rel)) ||
        hasName(/ravensight[\w.-]*\.uplugin$/i)
      );
    case 'ios': {
      if (hasName(/^Ravensight[\w.-]*\.swift$/i)) return true;
      for (const f of files) {
        const b = basename(f.rel);
        if (b !== 'Package.swift' && b !== 'Podfile') continue;
        const text = read(f.rel) || '';
        if (/ravensight/i.test(text)) return true;
      }
      return false;
    }
    case 'android': {
      if (hasName(/^Ravensight[\w.-]*\.(kt|java)$/i)) return true;
      for (const f of files) {
        if (!/(^|\/)build\.gradle(\.kts)?$/.test(f.rel)) continue;
        const text = read(f.rel) || '';
        if (/ravensight/i.test(text)) return true;
      }
      return false;
    }
    case 'odin':
      return hasName(/ravensight[\w.-]*\.odin$/i);
    case 'cpp':
      // cpp is only detected when CMakeLists.txt mentions ravensight,
      // which is itself the SDK reference.
      return true;
    default:
      return null; // custom: no SDK expected
  }
}

/**
 * Run every check over the scanned tree.
 * ctx = { engine, files, read } where read(rel) => text | null.
 * ctx.trackFunctions adds custom track call specs (see buildTrackPatterns).
 * ctx.includeTests and ctx.includeDocs widen the track call scope (see
 * inCallScope); key hygiene always covers every readable file.
 * Returns { findings, allFindings, totals, liveKeys, testKeys, inventory }
 * where findings is allFindings capped at 100
 * (a truncation info finding is appended when the cap is hit).
 */
export function runChecks(ctx) {
  const { engine, files, read, trackFunctions = [], includeTests = false, includeDocs = false } = ctx;
  const forms = buildTrackPatterns(trackFunctions);
  const findings = [];
  const liveKeys = [];
  const testKeys = [];
  const trackCalls = [];
  let flushSeen = false;
  let filesScannedForKeys = 0;
  let filesScannedForCalls = 0;
  // Calls to a track function in a file that none of its entries covers
  // (every entry has paths and none matches), by function name.
  const outsidePaths = new Map();
  const leftOut = { tests: 0, docs: 0, vendored: 0 };
  // HTML pages left out as docs, named so the report can say which.
  const htmlLeftOut = { count: 0, files: [] };

  for (const f of files) {
    const text = read(f.rel);
    if (text == null) continue; // binary or unreadable
    filesScannedForKeys++;
    const lines = text.split('\n');

    // Key scans cover every text file, SDK files included.
    const keyBucket = isTestPath(f.rel) ? testKeys : liveKeys;
    for (const m of text.matchAll(INGEST_KEY_RE)) keyBucket.push(m[0]);
    for (let li = 0; li < lines.length; li++) {
      for (const { re, kind } of WRONG_KEY_PATTERNS) {
        for (const m of lines[li].matchAll(re)) {
          findings.push(
            finding(
              'wrong_key_type',
              'error',
              'Secret credential found in the project tree',
              `Found ${kind} (${mask(m[0])}) in the source tree. ` +
                'Secrets of this type must never ship inside a game build. ' +
                'Remove it and rotate the credential.',
              f.rel,
              li + 1,
            ),
          );
        }
      }
    }

    if (/flush/i.test(text) || /\batexit\b|process\.on\(\s*['"](before)?exit/.test(text)) {
      flushSeen = true;
    }

    // Track call analysis skips the SDK's own files so SDK internals and
    // doc comments do not trip integration findings, and skips files out
    // of the call scope (tests, docs, vendored SDK directories).
    const excluded = callScopeExclusion(f.rel, { includeTests, includeDocs });
    if (excluded) {
      leftOut[excluded]++;
      if (excluded === 'docs' && HTML_FILE_RE.test(f.rel)) {
        htmlLeftOut.count++;
        if (htmlLeftOut.files.length < HTML_LEFT_OUT_MAX) htmlLeftOut.files.push(f.rel);
      }
      continue;
    }
    filesScannedForCalls++;

    // Calls are matched on the text with comments blanked out, which keeps
    // every line and column where it was.
    const code = stripComments(text, f.rel).split('\n');
    // Bodies of the custom track functions defined in this file, so a
    // wrapper's own forwarding call (logEvent(name) { rs.track(name) }) is
    // not counted as unresolved.
    const scopes = wrapperScopes(code, f.rel, forms, isDefinition);
    // Bodies of anonymous handlers (passed as an argument or assigned to a
    // property), whose calls forward a field of the handler's parameter.
    const handlers = handlerScopes(code, f.rel);
    const lua = extOf(f.rel) === 'lua';
    // The entry of each form that applies to this file (paths), or null.
    const entryOf = new Map(forms.map((fm) => [fm, resolveEntry(fm, f.rel)]));

    for (let li = 0; li < code.length; li++) {
      const line = code[li];
      // Every match of every form on the line. Two forms matching the same
      // "(" are one call, credited to the most specific form (the longest
      // name; the earlier form on a tie).
      const byOpen = new Map();
      for (const form of forms) {
        form.re.lastIndex = 0;
        for (const m of line.matchAll(form.re)) {
          const openIdx = m.index + m[0].indexOf('(');
          if (form.qualifier === 'none' && isQualified(line, m.index, lua)) {
            // Remembered so track_fn_unused can suggest the *. form.
            form.qualifiedSeen = (form.qualifiedSeen || 0) + 1;
            continue;
          }
          if (form.qualifier === 'any' && !isQualified(line, m.index, lua)) continue;
          if (isDefinition(line, m.index, openIdx)) continue;
          const entry = entryOf.get(form);
          // Raw matches before dedupe, so an entry that only ever lost to a
          // more specific form still counts as used for track_fn_unused.
          if (entry) entry.raw++;
          const prev = byOpen.get(openIdx);
          if (prev && prev.form.name.length >= form.name.length) continue;
          byOpen.set(openIdx, { form, openIdx });
        }
      }
      const matches = [...byOpen.values()].sort((a, b) => a.openIdx - b.openIdx);

      for (const { form, openIdx } of matches) {
        const entry = entryOf.get(form);
        if (!entry) {
          // Every entry for this name has paths and none covers this file:
          // paths limit where the name is a track function, so this call is
          // not one. It is only counted, in callsOutsidePaths.
          outsidePaths.set(form.name, (outsidePaths.get(form.name) || 0) + 1);
          continue;
        }
        const arg = extractArg(line, openIdx, entry.argIndex);
        const name = arg ? literalName(arg.expr) : null;
        const names = name === null && arg ? ternaryNames(arg.expr) : null;
        const call = { file: f.rel, line: li + 1, form: form.name, name };
        if (names) call.names = names;
        if (entry.paths) call.paths = entry.paths;
        if (
          !names &&
          name === null &&
          arg &&
          ((/^[A-Za-z_$][\w$]*$/.test(arg.expr) && isForwarded(scopes, li, openIdx, arg.expr)) ||
            isHandlerForwarded(handlers, li, openIdx, arg.expr.trim()))
        ) {
          call.forwarded = true;
        }
        trackCalls.push(call);
        entry.calls++;

        if (arg) {
          // A two literal ternary checks both arms; otherwise the first literal.
          const lits = names ? names.map((n) => ({ content: n, prefix: '' })) : [firstLiteral(arg.expr)].filter(Boolean);
          let cardinalityReported = false;
          for (const lit of lits) {
            if (lit.content.length > EVENT_NAME_MAX) {
              findings.push(
                finding(
                  'event_name_too_long',
                  'error',
                  'Event name longer than 200 characters',
                  `A track call uses a ${lit.content.length} character string literal as the event name. ` +
                    `The server rejects names over ${EVENT_NAME_MAX} characters. ` +
                    `It starts with "${clip(lit.content, 60)}".`,
                  f.rel,
                  li + 1,
                ),
              );
            }
            const interpolated =
              lit.content.includes('${') ||
              ((lit.prefix === 'f' || lit.prefix === '$') && lit.content.includes('{'));
            const concatenated =
              arg.outside.includes('+') ||
              arg.outside.includes('%') ||
              arg.outside.includes('..') ||
              arg.expr.includes('.format(') ||
              /\bstr\(/.test(arg.outside);
            const numbered = /\d{2,}/.test(lit.content);
            if ((interpolated || concatenated || numbered) && !cardinalityReported) {
              cardinalityReported = true;
              findings.push(
                finding(
                  'event_name_cardinality',
                  'warning',
                  'Event name looks high cardinality',
                  `The event name in this track call embeds ${
                    numbered && !interpolated && !concatenated
                      ? 'a multi digit number'
                      : 'string interpolation or concatenation'
                  } (near "${clip(arg.expr, 80)}"). ` +
                    'Identifiers like level numbers or player ids belong in the event data, ' +
                    'not the event name. High cardinality names fragment your analytics.',
                  f.rel,
                  li + 1,
                ),
              );
            }
          }
        }

        const payloadLen = measureInlinePayload(code, li, openIdx);
        if (payloadLen > PAYLOAD_MAX) {
          findings.push(
            finding(
              'large_inline_payload',
              'warning',
              'Inline event payload larger than 8KB',
              `An object literal inside this track call spans ${payloadLen} characters of source. ` +
                `The server caps event data at ${PAYLOAD_MAX} bytes serialized, so this event is ` +
                'likely to be rejected. Trim the payload or split the event.',
              f.rel,
              li + 1,
            ),
          );
        }
      }
    }
  }

  const sdkPresent = detectSdk(engine, files, read);

  if (engine !== 'custom' && sdkPresent === false) {
    findings.push(
      finding(
        'sdk_missing',
        'error',
        'No Ravensight SDK found for the detected engine',
        `This looks like a ${engine} project but no Ravensight SDK was found in it. ` +
          'Install the SDK for your engine, or run the doctor from the directory that contains it. ' +
          'SDK downloads: https://ravensight.io/docs/',
      ),
    );
  }

  if (liveKeys.length === 0) {
    findings.push(
      finding(
        'no_ingest_key',
        'warning',
        'No ingest key found in the project',
        'No gt_live_ ingest key was found anywhere in the tree' +
          (testKeys.length > 0
            ? ` outside test paths (${new Set(testKeys).size} found under test, fixture or mock paths, which do not count)`
            : '') +
          '. If you inject the key at runtime or build time this is fine. Otherwise the SDK has ' +
          'nothing to authenticate with and no events will arrive.',
      ),
    );
  }

  const nameCounts = new Map();
  for (const c of trackCalls) {
    for (const n of callNames(c)) nameCounts.set(n, (nameCounts.get(n) || 0) + 1);
  }
  const hint =
    'If your game calls track through its own function, name it with --track-fn <name> ' +
    'or trackFunctions in ravensight.config.json so the doctor can check the event names.';

  const unresolved = trackCalls.filter(isUnresolved);
  if (unresolved.length > 0) {
    findings.push(
      finding(
        'tracking_unresolved',
        'warning',
        `${unresolved.length} track call${unresolved.length === 1 ? '' : 's'} with an event name the doctor could not read`,
        unresolvedDetail(unresolved, trackCalls.filter((c) => !c.forwarded).length) + ' ' + hint,
        unresolved[0].file,
        unresolved[0].line,
      ),
    );
  }

  if (trackCalls.length > 0 && nameCounts.size === 0) {
    // Clause A: calls were found but none names its event with a literal,
    // so nothing about the names was checked.
    findings.push(
      finding(
        'tracking_unverified',
        'warning',
        'Track calls found, but no event names could be checked',
        `Found ${trackCalls.length} track call${trackCalls.length === 1 ? '' : 's'}, none with a ` +
          'string literal event name, so the event names were not checked. This usually means ' +
          'track is called with a variable inside a wrapper. ' +
          hint,
        trackCalls[0].file,
        trackCalls[0].line,
      ),
    );
  } else if (trackCalls.length === 0 && liveKeys.length > 0) {
    // Clause B: the project is wired to a real key but no call is
    // recognised, so the doctor cannot see how events are sent.
    findings.push(
      finding(
        'tracking_unverified',
        'warning',
        'Ingest key found, but no track calls recognised',
        'The project has an ingest key but none of the track call forms the doctor knows ' +
          'appear in it, so nothing about your events was checked. ' +
          hint,
      ),
    );
  } else if (sdkPresent === true && trackCalls.length === 0) {
    findings.push(
      finding(
        'no_track_calls',
        'info',
        'SDK present but no track calls found',
        'The Ravensight SDK is in the project but no track calls were found. ' +
          'Nothing beyond automatic session events will be recorded until you call track.',
      ),
    );
  }

  for (const form of forms) {
    if (form.source === 'builtin') continue;
    for (const e of form.entries) {
      if (e.raw) continue;
      const from = e.source === 'config' ? 'ravensight.config.json' : '--track-fn';
      findings.push(
        finding(
          'track_fn_unused',
          'info',
          'Custom track function never called',
          e.paths
            ? `The track function "${form.name}" for paths ${e.paths.join(', ')} (from ${from}) was not called in ` +
                'any scanned file those paths cover. Check the spelling and the paths, or that the file calling it is not ignored.'
            : `The track function "${form.name}" (from ${from}) ` +
                'was not called anywhere in the scanned files. Check the spelling, or that the file ' +
                'calling it is not ignored.' +
                (form.qualifier === 'none' && form.qualifiedSeen
                  ? ` It was called on a receiver ${form.qualifiedSeen} time${form.qualifiedSeen === 1 ? '' : 's'}, ` +
                    `which a bare name does not match; use *.${form.name} to count those calls.`
                  : ''),
        ),
      );
    }
  }

  if (engine === 'custom' && trackCalls.length > 0 && !flushSeen) {
    findings.push(
      finding(
        'flush_on_exit_missing',
        'info',
        'No flush or exit handling found',
        'This looks like a hand rolled integration with track calls but no flush or exit ' +
          'handling anywhere in the tree. Without a flush on shutdown the last batch of ' +
          'events is lost when the game closes.',
      ),
    );
  }

  const all = sortFindings(findings);
  const capped = capFindings(all);

  const eventNames = [...nameCounts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const inventory = {
    trackCalls,
    eventNames,
    unresolvedCalls: unresolved.length,
    forwardedCalls: trackCalls.filter((c) => c.forwarded).length,
    filesScannedForCalls,
    filesScannedForKeys,
    filesLeftOutOfCallScan: leftOut,
    htmlLeftOutOfCallScan: htmlLeftOut,
    callsOutsidePaths: [...outsidePaths.values()].reduce((a, b) => a + b, 0),
    trackFunctions: forms.flatMap((fm) =>
      fm.entries.map((e) => {
        const row = { name: fm.name, argIndex: e.argIndex, source: e.source, calls: e.calls };
        if (e.paths) row.paths = e.paths;
        return row;
      }),
    ),
    ingestKeys: { live: new Set(liveKeys).size, test: new Set(testKeys).size },
  };

  return { findings: capped, allFindings: all, totals: countBySeverity(all), liveKeys, testKeys, inventory };
}

/**
 * The tracking_unresolved detail: the share of calls, then up to 20
 * file:line locations, as many as fit in the detail cap.
 */
function unresolvedDetail(unresolved, total) {
  const pct = Math.round((unresolved.length / total) * 100);
  let text =
    `${unresolved.length} of ${total} recognised track calls (${pct} percent) do not name ` +
    'the event with a string literal on the call line, so those names were not checked';
  text +=
    unresolved.length / total >= UNRESOLVED_INCONCLUSIVE_SHARE
      ? ', which makes the status inconclusive (25 percent or more).'
      : '.';
  const budget = DETAIL_MAX - 400; // room for the hint
  const listed = [];
  let used = 0;
  for (const c of unresolved.slice(0, MAX_LISTED_UNRESOLVED)) {
    const loc = `${c.file}:${c.line}`;
    if (used + loc.length + 2 > budget - text.length) break;
    listed.push(loc);
    used += loc.length + 2;
  }
  const more = unresolved.length - listed.length;
  if (listed.length > 0) text += ` At ${listed.join(', ')}${more > 0 ? `, and ${more} more` : ''}.`;
  return text;
}

/** The event names a call resolved to: one literal, the two arms of a ternary, or none. */
export function callNames(c) {
  if (c.name != null) return [c.name];
  return Array.isArray(c.names) ? c.names : [];
}

/** A call whose event name the doctor could not read, and that is not forwarded. */
function isUnresolved(c) {
  return callNames(c).length === 0 && !c.forwarded;
}

/**
 * Is the share of unresolved calls in an inventory high enough to make
 * the status inconclusive? Forwarding calls inside a named wrapper are
 * left out of both sides.
 */
export function unresolvedInconclusive(inventory) {
  if (!inventory || !Array.isArray(inventory.trackCalls)) return false;
  const total = inventory.trackCalls.length - (inventory.forwardedCalls || 0);
  return total > 0 && inventory.unresolvedCalls / total >= UNRESOLVED_INCONCLUSIVE_SHARE;
}

export function countBySeverity(findings) {
  let errors = 0;
  let warnings = 0;
  for (const f of findings) {
    if (f.severity === 'error') errors++;
    else if (f.severity === 'warning') warnings++;
  }
  return { errors, warnings };
}

/** The warning added when --live sent its event but could not read it back. */
export function liveUnconfirmedFinding(note) {
  return finding('live_ping_unconfirmed', 'warning', 'Live ping accepted but not confirmed as stored', note);
}

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

/** Findings in severity order (errors, warnings, info), stable within each. */
export function sortFindings(findings) {
  return findings.slice().sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/**
 * Sort and cap findings at 100. Past the cap the first 99 are kept and a
 * findings_truncated info marker says how many were produced, so nothing is
 * dropped silently.
 */
export function capFindings(findings) {
  const all = sortFindings(findings);
  if (all.length <= MAX_FINDINGS) return all;
  const capped = all.slice(0, MAX_FINDINGS - 1);
  capped.push(
    finding(
      'findings_truncated',
      'info',
      'Findings truncated',
      `${all.length} findings were produced but only the first ${MAX_FINDINGS - 1} ` +
        'are listed. Fix what is here and run the doctor again.',
    ),
  );
  return capped;
}

/** The error added when --live could not deliver its event at all. */
export function liveFailedFinding(stage, note) {
  return finding('live_check_failed', 'error', `Live check failed at the ${stage} step`, note);
}
