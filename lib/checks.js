// Integration checks for ravensight-doctor.
//
// Every check produces findings of the shape
//   { id, severity: "error" | "warning" | "info", title, detail, file, line }
// with title, detail and file capped to the report API limits.
//
// The scanner is line based and conservative: it prefers missing a clever
// case over reporting a false positive.

import { stripComments } from './comments.js';

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
 * spec { name, argIndex, source }. A plain custom name matches a call to
 * that function with or without a receiver; a dotted name anchors its
 * first segment at an identifier boundary, so Analytics.logEvent matches
 * Game.Analytics.logEvent( but not MyAnalytics.logEvent(. A Lua method
 * name such as telemetry:track matches telemetry:track( and
 * telemetry.track( both.
 * Returns [{ name, re, argIndex, source }].
 */
export function buildTrackPatterns(custom = []) {
  const forms = BUILTIN_FORMS.map((f) => ({ ...f, re: new RegExp(f.re.source, 'g'), source: 'builtin' }));
  const seen = new Set(forms.map((f) => f.name));
  for (const spec of custom) {
    if (seen.has(spec.name)) continue;
    seen.add(spec.name);
    forms.push({
      name: spec.name,
      re: new RegExp('(?<![\\w$])' + spec.name.split(':').map(escapeRe).join('[:.]') + '\\(', 'g'),
      argIndex: spec.argIndex ?? 0,
      source: spec.source || 'flag',
    });
  }
  return forms;
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
const TEST_DIRS = new Set(['__tests__', '__fixtures__', '__mocks__', 'fixtures', 'test', 'tests']);
const TEST_FILE_RE = /\.(?:test|spec)\./;

/** Is rel (a forward slash path relative to the scan root) a test path? */
export function isTestPath(rel) {
  const parts = rel.split('/');
  const base = parts.pop();
  return parts.some((d) => TEST_DIRS.has(d)) || TEST_FILE_RE.test(base);
}

// Track call scope. Files under these directories (basename match at any
// depth) are left out of the track call inventory by default: test
// directories come back with includeTests, docs and example directories
// with includeDocs. Key scanning always covers them.
const CALL_TEST_DIRS = new Set([...TEST_DIRS, 'spec', 'specs']);
const CALL_DOC_DIRS = new Set(['docs', 'doc', 'examples', 'example']);
const DOC_FILE_RE = /\.(?:md|mdx|rst|txt|html|htm)$/i;
// A vendored copy of the SDK (lib/ravensight/, vendor/ravensight/,
// addons/ravensight/) is never part of the inventory.
const VENDORED_SDK_DIR = 'ravensight';

/**
 * Is rel scanned for track calls? Test paths, docs and vendored SDK
 * directories are out of scope unless includeTests or includeDocs say
 * otherwise. Key hygiene ignores this and scans everything.
 */
export function inCallScope(rel, { includeTests = false, includeDocs = false } = {}) {
  const parts = rel.split('/');
  const base = parts.pop();
  if (parts.some((d) => d.toLowerCase() === VENDORED_SDK_DIR)) return false;
  if (!includeTests && (isTestPath(rel) || parts.some((d) => CALL_TEST_DIRS.has(d)))) return false;
  if (!includeDocs && (DOC_FILE_RE.test(base) || parts.some((d) => CALL_DOC_DIRS.has(d)))) return false;
  return true;
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

/** The identifiers in a definition's parameter list, opened at openIdx. */
function paramNames(line, openIdx) {
  const close = closeParen(line, openIdx);
  const inner = line.slice(openIdx + 1, close === -1 ? line.length : close);
  return new Set(inner.match(/[A-Za-z_$][\w$]*/g) || []);
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
  const callsByForm = new Map();
  let flushSeen = false;
  let filesScannedForKeys = 0;
  let filesScannedForCalls = 0;

  for (const f of files) {
    const text = read(f.rel);
    if (text == null) continue; // binary or unreadable
    filesScannedForKeys++;
    const lines = text.split('\n');
    const isSdkFile = SDK_FILE_RE.test(basename(f.rel));

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
    if (isSdkFile || !inCallScope(f.rel, { includeTests, includeDocs })) continue;
    filesScannedForCalls++;

    // Calls are matched on the text with comments blanked out, which keeps
    // every line and column where it was.
    const code = stripComments(text, f.rel).split('\n');
    // Parameters of the custom track functions defined in this file, so a
    // wrapper's own forwarding call (logEvent(name) { rs.track(name) }) is
    // not counted as unresolved.
    const wrapperParams = new Set();

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
          if (isDefinition(line, m.index, openIdx)) {
            if (form.source !== 'builtin') for (const p of paramNames(line, openIdx)) wrapperParams.add(p);
            continue;
          }
          const prev = byOpen.get(openIdx);
          if (prev && prev.form.name.length >= form.name.length) continue;
          byOpen.set(openIdx, { form, openIdx });
        }
      }
      const matches = [...byOpen.values()].sort((a, b) => a.openIdx - b.openIdx);

      for (const { form, openIdx } of matches) {
        const argIndex = form.argIndex;
        const arg = extractArg(line, openIdx, argIndex);
        const name = arg ? literalName(arg.expr) : null;
        const call = { file: f.rel, line: li + 1, form: form.name, name };
        if (name === null && arg && /^[A-Za-z_$][\w$]*$/.test(arg.expr) && wrapperParams.has(arg.expr)) {
          call.forwarded = true;
        }
        trackCalls.push(call);
        callsByForm.set(form.name, (callsByForm.get(form.name) || 0) + 1);

        if (arg) {
          const lit = firstLiteral(arg.expr);
          if (lit) {
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
            if (interpolated || concatenated || numbered) {
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
    if (c.name !== null) nameCounts.set(c.name, (nameCounts.get(c.name) || 0) + 1);
  }
  const hint =
    'If your game calls track through its own function, name it with --track-fn <name> ' +
    'or trackFunctions in ravensight.config.json so the doctor can check the event names.';

  const unresolved = trackCalls.filter((c) => c.name === null && !c.forwarded);
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
    if (form.source === 'builtin' || callsByForm.get(form.name)) continue;
    findings.push(
      finding(
        'track_fn_unused',
        'info',
        'Custom track function never called',
        `The track function "${form.name}" (from ${form.source === 'config' ? 'ravensight.config.json' : '--track-fn'}) ` +
          'was not called anywhere in the scanned files. Check the spelling, or that the file ' +
          'calling it is not ignored.',
      ),
    );
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
    trackFunctions: forms.map((fm) => ({
      name: fm.name,
      argIndex: fm.argIndex,
      source: fm.source,
      calls: callsByForm.get(fm.name) || 0,
    })),
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
