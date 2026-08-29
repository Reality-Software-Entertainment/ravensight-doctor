// Integration checks for ravensight-doctor.
//
// Every check produces findings of the shape
//   { id, severity: "error" | "warning" | "info", title, detail, file, line }
// with title, detail and file capped to the report API limits.
//
// The scanner is line based and conservative: it prefers missing a clever
// case over reporting a false positive.

const TITLE_MAX = 200;
const DETAIL_MAX = 1000;
const FILE_MAX = 300;
const EVENT_NAME_MAX = 200;
const PAYLOAD_MAX = 8 * 1024; // server caps event data at 8KB serialized
const MAX_FINDINGS = 100;

// Track call patterns. Each regex anchors the receiver at a word boundary
// so e.g. "colors.track(" does not match "rs.track(". argIndex says which
// argument holds the event name (Odin passes the client first).
const TRACK_PATTERNS = [
  { re: /(^|[^.\w])Ravensight\.track\(/, argIndex: 0 },
  { re: /(^|[^.\w])Ravensight\.Track\(/, argIndex: 0 },
  { re: /(^|[^.\w])rs\.track\(/, argIndex: 0 },
  { re: /(^|[^.\w])ravensight\.track\(/, argIndex: 0 },
  { re: /->Track\(/, argIndex: 0 },
  { re: /(^|[^.\w])track\(client,/, argIndex: 1 },
];

// Credentials that must never ship inside a game build.
const WRONG_KEY_PATTERNS = [
  { re: /gt_mcp_[A-Za-z0-9_]{8,}/g, kind: 'a Ravensight MCP personal access token' },
  { re: /\b(?:sk|rk)_live_[A-Za-z0-9]{8,}/g, kind: 'a Stripe live secret key' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, kind: 'an AWS access key id' },
];

const INGEST_KEY_RE = /gt_live_[A-Za-z0-9]{4,}/g;

// File basenames that are the SDK itself; their bodies (docs, examples,
// internal calls) are excluded from track call analysis so SDK internals
// do not trip integration findings. Key scanning still covers them.
const SDK_FILE_RE = /^ravensight[\w.-]*\.(gd|cs|js|mjs|cjs|ts|swift|kt|java|odin|h|hpp|c|cpp|uplugin)$/i;

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
 * Returns { findings, liveKeys } with findings capped at 100
 * (a truncation info finding is appended when the cap is hit).
 */
export function runChecks(ctx) {
  const { engine, files, read } = ctx;
  const findings = [];
  const liveKeys = [];
  const trackCalls = [];
  let flushSeen = false;

  for (const f of files) {
    const text = read(f.rel);
    if (text == null) continue; // binary or unreadable
    const lines = text.split('\n');
    const isSdkFile = SDK_FILE_RE.test(basename(f.rel));

    // Key scans cover every text file, SDK files included.
    for (const m of text.matchAll(INGEST_KEY_RE)) liveKeys.push(m[0]);
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
    // doc comments do not trip integration findings.
    if (isSdkFile) continue;

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      for (const { re, argIndex } of TRACK_PATTERNS) {
        const m = re.exec(line);
        if (!m) continue;
        const openIdx = m.index + m[0].indexOf('(');
        trackCalls.push({ file: f.rel, line: li + 1 });

        const arg = extractArg(line, openIdx, argIndex);
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

        const payloadLen = measureInlinePayload(lines, li, openIdx);
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
        break; // one pattern match per line is enough
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
        'No gt_live_ ingest key was found anywhere in the tree. If you inject the key at ' +
          'runtime or build time this is fine. Otherwise the SDK has nothing to authenticate ' +
          'with and no events will arrive.',
      ),
    );
  }

  if (sdkPresent === true && trackCalls.length === 0) {
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

  const severityRank = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  let capped = findings;
  if (findings.length > MAX_FINDINGS) {
    capped = findings.slice(0, MAX_FINDINGS - 1);
    capped.push(
      finding(
        'findings_truncated',
        'info',
        'Findings truncated',
        `${findings.length} findings were produced but only the first ${MAX_FINDINGS - 1} ` +
          'are listed. Fix what is here and run the doctor again.',
      ),
    );
  }

  return { findings: capped, totals: countBySeverity(findings), liveKeys };
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
