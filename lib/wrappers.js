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
//
// Besides "function name(" and method shorthand "name(args) {", a wrapper
// can be assigned to a name, field or property:
//   Lua  track = function(n, d) ... end      (a table constructor field)
//   Lua  M.track = function(name, data) ... end
//   JS   track: function (name, data) { ... }
//   JS   const track = (name, data) => rs.track(name, data)
//   JS   track = async name => { ... }
// An arrow function with an expression body ends at the end of its
// statement: a ";", a "," or closing bracket outside its own brackets, or
// the end of the line once its brackets are balanced.

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
 * End of an arrow function body that starts after the "=>" at (li, from):
 * a braced body ends at its "}", an expression body at the end of its
 * statement.
 */
function arrowEnd(code, li, from) {
  // Skip to the first character of the body, which may be on a later line.
  let i = li;
  let k = from;
  while (i < code.length) {
    while (k < code[i].length && /\s/.test(code[i][k])) k++;
    if (k < code[i].length) break;
    i++;
    k = 0;
  }
  if (i >= code.length) return null;
  if (code[i][k] === '{') return braceEnd(code, i, k);
  let depth = 0;
  for (; i < code.length; i++, k = 0) {
    const line = code[i];
    let inStr = null;
    let esc = false;
    for (; k < line.length; k++) {
      const c = line[k];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === inStr) inStr = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') inStr = c;
      else if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        if (--depth < 0) return { line: i, col: k };
      } else if ((c === ';' || c === ',') && depth === 0) return { line: i, col: k };
    }
    if (depth <= 0) return { line: i, col: line.length };
  }
  return { line: code.length, col: 0 };
}

/**
 * Assigned wrappers on one line: "seg = function(", "seg: function(",
 * "seg = (args) =>" and "seg = arg =>", as
 * [{ params, start: col, end }]. Lua only takes the function form.
 */
function assignedScopes(code, li, segRe, ext) {
  const line = code[li];
  const found = [];
  segRe.lastIndex = 0;
  for (const m of line.matchAll(segRe)) {
    const after = m.index + m[0].length;
    const rest = line.slice(after);
    const fn = /^(?:async\s+)?function\b\s*(?:[A-Za-z_$][\w$]*\s*)?\(/.exec(rest);
    if (fn) {
      const openIdx = after + fn[0].length - 1;
      const close = closeParen(line, openIdx);
      if (close === -1) continue;
      const params = parameterNames(line.slice(openIdx + 1, close));
      if (params.size === 0) continue;
      const end = ext === 'lua' ? luaEnd(code, li, close + 1) : braceEnd(code, li, close + 1);
      if (end) found.push({ params, start: { line: li, col: close }, end });
      continue;
    }
    if (ext === 'lua') continue;
    let params;
    let arrowAt;
    const paren = /^(?:async\s*)?\(/.exec(rest);
    if (paren) {
      const openIdx = after + paren[0].length - 1;
      const close = closeParen(line, openIdx);
      if (close === -1) continue;
      const arrow = /^\s*(?::\s*[\w<>[\]|,.? ]+?\s*)?=>/.exec(line.slice(close + 1));
      if (!arrow) continue; // a call or a grouping, not an arrow function
      params = parameterNames(line.slice(openIdx + 1, close));
      arrowAt = close + 1 + arrow[0].length;
    } else {
      const single = /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(rest);
      if (!single) continue;
      params = new Set(NOT_PARAMS.has(single[1]) ? [] : [single[1]]);
      arrowAt = after + single[0].length;
    }
    if (params.size === 0) continue;
    const end = arrowEnd(code, li, arrowAt);
    if (end) found.push({ params, start: { line: li, col: arrowAt - 1 }, end });
  }
  return found;
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
  const indented = ext === 'gd' || ext === 'py';
  // name = ..., name: ... (never ==, ===, => or ::)
  const assignRe = new RegExp(
    '(?<![\\w$])(?:' + segments.map(escapeRe).join('|') + ')\\s*(?:=(?![=>])|:(?!:))\\s*',
    'g',
  );
  const scopes = [];
  for (let li = 0; li < code.length; li++) {
    const line = code[li];
    if (!indented) scopes.push(...assignedScopes(code, li, assignRe, ext));
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
