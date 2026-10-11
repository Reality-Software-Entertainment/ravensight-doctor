// Wrapper bodies for ravensight-doctor.
//
// A project that names its own track function (--track-fn logEvent) usually
// defines it as a thin wrapper whose body passes a parameter straight on:
// function logEvent(name, data) { rs.track(name, data) }. That inner call
// can never have a literal name, and the names are checked where the
// wrapper is called instead, so it is counted as forwarded, not unresolved.
//
// This module finds the definitions of the custom track functions in one
// file (matched on the spec's last segment, so Analytics.log_event finds
// func log_event( and telemetry:track finds function telemetry:track() and
// works out where each body ends: brace depth for C style languages,
// indentation for GDScript and Python, and block keywords up to the
// matching end for Lua. The parameters are only in force inside that body.

import { extOf } from './comments.js';

const IDENT_RE = /[A-Za-z_$][\w$]*/g;
const NOT_PARAMS = new Set(['self', 'this', '_']);
// What may sit between a definition's ")" and its "{": a return type,
// "->", "throws X", "const", "override" and the like.
const BEFORE_BODY_RE = /^[\s\w:<>[\],.?|&*-]$/;

function escapeRe(s) {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/** Index of the ")" closing the "(" at openIdx on this line, or -1. */
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

/**
 * The parameter names of a parameter list: types, defaults and self or
 * this are dropped. "name: String = \"x\"", "string name", "_ name: String"
 * and "std::string name" all give name.
 */
export function parameterNames(list) {
  const names = new Set();
  let depth = 0;
  let part = '';
  const parts = [];
  for (const c of list) {
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '}' || c === '>') depth--;
    if (c === ',' && depth === 0) {
      parts.push(part);
      part = '';
    } else part += c;
  }
  parts.push(part);
  for (let p of parts) {
    p = p.replace(/::/g, '.');
    const eq = p.indexOf('=');
    if (eq !== -1) p = p.slice(0, eq);
    const colon = p.indexOf(':');
    if (colon !== -1) p = p.slice(0, colon);
    const ids = p.match(IDENT_RE);
    if (!ids) continue;
    const name = ids[ids.length - 1];
    if (!NOT_PARAMS.has(name)) names.add(name);
  }
  return names;
}

function before(a, b) {
  return a.line < b.line || (a.line === b.line && a.col < b.col);
}

/** End of a C style body: the "}" matching the first "{" after ")". */
function braceEnd(code, li, from) {
  let depth = 0;
  for (let i = li; i < code.length; i++) {
    const line = code[i];
    let inStr = null;
    let esc = false;
    for (let k = i === li ? from : 0; k < line.length; k++) {
      const c = line[k];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === inStr) inStr = null;
        continue;
      }
      if (depth === 0) {
        if (c === '{') depth = 1;
        else if (!BEFORE_BODY_RE.test(c)) return null; // no body: "=", ";", "=>" and so on
        continue;
      }
      if (c === '"' || c === "'" || c === '`') inStr = c;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return { line: i, col: k };
    }
  }
  return depth > 0 ? { line: code.length, col: 0 } : null;
}

/** End of an indented body: the next non blank line indented no deeper. */
function indentEnd(code, li) {
  const indent = /^[ \t]*/.exec(code[li])[0].length;
  for (let i = li + 1; i < code.length; i++) {
    if (code[i].trim() === '') continue;
    if (/^[ \t]*/.exec(code[i])[0].length <= indent) return { line: i, col: 0 };
  }
  return { line: code.length, col: 0 };
}

/** End of a Lua function body: the end that balances its blocks. */
function luaEnd(code, li, from) {
  let depth = 1;
  const word = /\b(function|if|do|repeat|end|until)\b/g;
  for (let i = li; i < code.length; i++) {
    const line = code[i];
    word.lastIndex = i === li ? from : 0;
    let m;
    while ((m = word.exec(line)) !== null) {
      if (m[1] === 'end' || m[1] === 'until') {
        if (--depth === 0) return { line: i, col: m.index };
      } else depth++;
    }
  }
  return { line: code.length, col: 0 };
}

/**
 * The bodies of the custom track functions defined in one file, as
 * [{ params: Set, start: { line, col }, end: { line, col } }] with 0 based
 * lines. code is the comment stripped text split into lines; isDefinition
 * is (line, start, openIdx) => boolean.
 */
export function wrapperScopes(code, rel, forms, isDefinition) {
  const custom = forms.filter((f) => f.source !== 'builtin');
  if (custom.length === 0) return [];
  const segments = [...new Set(custom.map((f) => f.name.split(/[.:]/).pop()))];
  const re = new RegExp('(?<![\\w$])(?:' + segments.map(escapeRe).join('|') + ')\\(', 'g');
  const ext = extOf(rel);
  const scopes = [];
  for (let li = 0; li < code.length; li++) {
    const line = code[li];
    re.lastIndex = 0;
    for (const m of line.matchAll(re)) {
      const openIdx = m.index + m[0].length - 1;
      if (!isDefinition(line, m.index, openIdx)) continue;
      const close = closeParen(line, openIdx);
      if (close === -1) continue; // a parameter list over several lines is not followed
      const params = parameterNames(line.slice(openIdx + 1, close));
      if (params.size === 0) continue;
      let end;
      if (ext === 'gd' || ext === 'py') end = indentEnd(code, li);
      else if (ext === 'lua') end = luaEnd(code, li, close + 1);
      else end = braceEnd(code, li, close + 1);
      if (end) scopes.push({ params, start: { line: li, col: close }, end });
    }
  }
  return scopes;
}

/** Is a call at (line, col) passing ident inside a wrapper that has it as a parameter? */
export function isForwarded(scopes, line, col, ident) {
  const at = { line, col };
  return scopes.some((s) => s.params.has(ident) && before(s.start, at) && before(at, s.end));
}
