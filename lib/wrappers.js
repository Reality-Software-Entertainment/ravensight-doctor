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
 * is (line, start, openIdx, ext) => boolean.
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
      if (!isDefinition(line, m.index, openIdx, ext)) continue;
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
  // The parameters plus the locals derived from them (const event = name),
  // for the object literal and queue rules. isForwarded keeps reading only
  // the parameters themselves.
  for (const sc of scopes) {
    sc.derived = new Set(sc.params);
    derivedLocals(code, sc.start, sc.end, sc.derived, new Set(), ext === 'lua');
  }
  return scopes;
}

/** Is a call at (line, col) passing ident inside a wrapper that has it as a parameter? */
export function isForwarded(scopes, line, col, ident) {
  const at = { line, col };
  return scopes.some((s) => s.params.has(ident) && before(s.start, at) && before(at, s.end));
}

// Object literals and queued call objects.
//
// Two more shapes pass a wrapper's name parameter on without a bare
// identifier argument:
//   vendor.capture({ event: name, properties })      (or the shorthand { event })
//   queue.push({ event: name, props });  ...  for (const call of queue) client.capture(call.event, call.props)
// The first counts as forwarded when the argument at the entry's argIndex is
// an object literal whose event, name or event_name property is a parameter
// of the wrapper around the call, or a local derived from one. The second
// counts when the member read from a loop variable (call.event) is a key
// that the same file pushes into the iterated array from inside a wrapper,
// with the name parameter as its value. One level only: the array is matched
// by its last name segment, JavaScript and TypeScript files only, and a
// queue filled by a helper that is not itself a track function, a queue
// built any other way (spread, concat, assignment) or one read with
// shift()/pop() is not followed (use ignoreCalls). A string literal as the
// value (event: 'x') is never forwarded.

const NAME_KEYS = new Set(['event', 'name', 'event_name']);

/** The top level pieces of an object literal's body, or null when expr is not one. */
function objectPieces(expr) {
  const t = expr.trim();
  if (t[0] !== '{') return null;
  const pieces = [];
  let depth = 0;
  let inStr = null;
  let esc = false;
  let part = '';
  for (let k = 0; k < t.length; k++) {
    const c = t[k];
    if (inStr) {
      part += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c;
      part += c;
      continue;
    }
    if (c === '{' || c === '(' || c === '[') {
      if (++depth === 1 && c === '{') continue;
    } else if (c === '}' || c === ')' || c === ']') {
      if (--depth === 0) {
        pieces.push(part);
        return pieces;
      }
    } else if (c === ',' && depth === 1) {
      pieces.push(part);
      part = '';
      continue;
    }
    part += c;
  }
  return null; // unbalanced
}

/**
 * The event, name or event_name properties of an object literal as
 * [{ key, value, raw }], value being the identifier it holds ('' for
 * anything else: a string, a call, a member) and raw the value's text
 * (call.event). The shorthand { event } holds event.
 */
export function nameProperties(expr) {
  const pieces = objectPieces(expr);
  if (!pieces) return [];
  const out = [];
  for (const raw of pieces) {
    const p = raw.trim();
    let m = /^(?:(["'])([\w$]+)\1|([\w$]+))\s*:\s*([\s\S]*)$/.exec(p);
    if (m) {
      const key = m[2] || m[3];
      if (!NAME_KEYS.has(key)) continue;
      const v = m[4].trim();
      out.push({ key, value: /^[A-Za-z_$][\w$]*$/.test(v) ? v : '', raw: v });
      continue;
    }
    m = /^([A-Za-z_$][\w$]*)$/.exec(p);
    if (m && NAME_KEYS.has(m[1])) out.push({ key: m[1], value: m[1], raw: m[1] });
  }
  return out;
}

/**
 * The string literal (with its quotes) held by the first event, name or
 * event_name property of an object literal, or null when there is none:
 * { event: 'level_start' } gives 'level_start'. A template literal with
 * an interpolation is not a plain literal and gives null.
 */
export function nameLiteral(expr) {
  const pieces = objectPieces(expr);
  if (!pieces) return null;
  for (const raw of pieces) {
    const m = /^\s*(?:(["'])([\w$]+)\1|([\w$]+))\s*:\s*((["'`])(?:\\.|(?!\5)[^\\])*\5)\s*$/.exec(raw);
    if (!m || !NAME_KEYS.has(m[2] || m[3])) continue;
    if (m[4][0] === '`' && m[4].includes('${')) continue;
    return m[4];
  }
  return null;
}

function scopesAround(scopes, line, col) {
  const at = { line, col };
  return scopes.filter((s) => before(s.start, at) && before(at, s.end));
}

/**
 * Is a call at (line, col) whose name argument is the object literal expr
 * passing a parameter of the wrapper around it (or a local derived from
 * one) as its event, name or event_name?
 */
export function isObjectForwarded(scopes, line, col, expr) {
  const props = nameProperties(expr).filter((p) => p.value);
  if (props.length === 0) return false;
  return scopesAround(scopes, line, col).some((s) => props.some((p) => s.derived.has(p.value)));
}

const lastSegment = (path) => path.split('.').pop();

/**
 * The queues a file fills from a wrapper: { queue last segment => Set of
 * keys } for every NAME.push({ key: <param or derived local> }) (or
 * unshift) inside a wrapper body. Only JavaScript and TypeScript.
 */
export function queueKeys(code, scopes, rel) {
  const keys = new Map();
  const ext = extOf(rel);
  if (ext === 'gd' || ext === 'py' || ext === 'lua') return keys;
  const re = /([A-Za-z_$][\w$.]*)\.(?:push|unshift)\(\s*(?=\{)/g;
  for (let li = 0; li < code.length; li++) {
    for (const m of code[li].matchAll(re)) {
      const at = m.index + m[0].length;
      const text = [code[li].slice(at), ...code.slice(li + 1, li + 40)].join('\n');
      const inside = scopesAround(scopes, li, m.index);
      if (inside.length === 0) continue;
      for (const p of nameProperties(text)) {
        if (!p.value || !inside.some((s) => s.derived.has(p.value))) continue;
        const q = lastSegment(m[1]);
        if (!keys.has(q)) keys.set(q, new Set());
        keys.get(q).add(p.key);
      }
    }
  }
  return keys;
}

/**
 * Loop bodies over a named array, as [{ iter, vars: Map(local => key|null),
 * item, start, end }]: for (const call of queue), for (const { event } of
 * queue) and queue.forEach((call) => ...). JavaScript and TypeScript only.
 */
export function loopScopes(code, rel) {
  const ext = extOf(rel);
  if (ext === 'gd' || ext === 'py' || ext === 'lua') return [];
  const out = [];
  const forOf = /(?<![\w$.])for\s*(?:await\s*)?\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*|\{[^}]*\})\s+of\s+([A-Za-z_$][\w$.]*)\s*\)/g;
  const each = /([A-Za-z_$][\w$.]*)\.forEach\(\s*(?:async\s*)?(?:function\s*\w*\s*\(\s*([A-Za-z_$][\w$]*|\{[^}]*\})[^)]*\)\s*(?=\{)|\(\s*([A-Za-z_$][\w$]*|\{[^}]*\})[^)]*\)\s*=>|([A-Za-z_$][\w$]*)\s*=>)/g;
  const add = (iter, binding, li, bodyFrom, endFn) => {
    const end = endFn(code, li, bodyFrom);
    if (!end) return;
    const names = new Map();
    let item = null;
    if (binding.startsWith('{')) {
      for (let piece of binding.slice(1, binding.lastIndexOf('}')).split(',')) {
        const eq = piece.indexOf('=');
        if (eq !== -1) piece = piece.slice(0, eq);
        const [key, local] = piece.split(':').map((x) => x.trim());
        if (/^[A-Za-z_$][\w$]*$/.test(key)) names.set(local && /^[A-Za-z_$][\w$]*$/.test(local) ? local : key, key);
      }
    } else item = binding;
    out.push({ iter, item, names, start: { line: li, col: bodyFrom }, end });
  };
  for (let li = 0; li < code.length; li++) {
    for (const m of code[li].matchAll(forOf)) add(m[2], m[1], li, m.index + m[0].length, arrowEnd);
    for (const m of code[li].matchAll(each)) {
      const binding = m[2] || m[3] || m[4];
      add(m[1], binding, li, m.index + m[0].length, m[2] ? braceEnd : arrowEnd);
    }
  }
  return out;
}

/**
 * Is a call at (line, col) whose name argument is expr reading a key that a
 * wrapper pushes into the array the enclosing loop iterates: call.event or
 * call['event'] with call the loop variable, or a destructured event?
 */
export function isQueueForwarded(loops, queues, line, col, expr) {
  if (queues.size === 0) return false;
  const e = expr.trim();
  const at = { line, col };
  const inside = loops.filter((l) => before(l.start, at) && before(at, l.end));
  const member = /^([A-Za-z_$][\w$]*)\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(["'])([\w$]+)\3\s*\])$/.exec(e);
  for (const l of inside) {
    const pushed = queues.get(lastSegment(l.iter));
    if (!pushed) continue;
    if (member && l.item === member[1] && pushed.has(member[2] || member[4])) return true;
    if (!member && l.names.has(e) && pushed.has(l.names.get(e))) return true;
  }
  return false;
}

// Handler bodies.
//
// A message or event handler passed as an argument or assigned to a
// property often forwards a field of its parameter rather than the
// parameter itself, as a love.js bridge does:
//   window.addEventListener('message', (m) => { c.track(m.name, m.data) })
//   bridge.onmessage = function (msg) { c.track(msg['event']) }
//   handlers = { track = function(m) c.track(m.name) end }   (Lua)
// The names come from whatever posts the message, so a call inside the
// handler's body whose name argument is <param>.<field> (or
// <param>['field']), or a name the parameter list destructures
// (({ name }) => c.track(name)), is counted as forwarded. A plain
// parameter passed on (items.forEach((n) => c.track(n))) is not: only a
// field of a message is taken as forwarded.

// What may sit right before an anonymous function for it to be an argument
// or a property value: "(", "," or an object key ":" ("{" in Lua).
const HANDLER_BEFORE_JS_RE = /(?:[(,]|(?<![:?])[A-Za-z_$\])'"]\s*:)\s*(?:async\s+)?$/;
// A property assignment: obj.onmessage = or obj['x'] = (never ==, <= or >=).
const HANDLER_ASSIGN_JS_RE = /(?:\.[A-Za-z_$][\w$]*|\])\s*=\s*(?:async\s+)?$/;
const HANDLER_BEFORE_LUA_RE = /(?:[(,{]|[\w\]]\s*=)\s*$/;
const LOCAL_LUA_RE = /^\s*local\s+[\w\s,]*=\s*$/;
// A bare function name assigned to a property: obj.onmessage = handle;
const ASSIGNED_NAME_JS_RE = /(?:\.[A-Za-z_$][\w$]*|\])\s*=(?![=>])\s*([A-Za-z_$][\w$]*)\s*(?=;|$|\))/g;

/**
 * The names a parameter list makes available, split into plain parameters
 * (params) and names a destructuring pattern binds (fields).
 */
function handlerParams(list) {
  const params = new Set();
  const fields = new Set();
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
  for (const raw of parts) {
    const p = raw.trim();
    if (p.startsWith('{')) {
      // { name, data: payload, kind = 'x' }: the bound names.
      const inner = p.slice(1, p.lastIndexOf('}') === -1 ? undefined : p.lastIndexOf('}'));
      for (let piece of inner.split(',')) {
        const eq = piece.indexOf('=');
        if (eq !== -1) piece = piece.slice(0, eq);
        const colon = piece.indexOf(':');
        if (colon !== -1) piece = piece.slice(colon + 1);
        const ids = piece.match(IDENT_RE);
        if (ids) fields.add(ids[ids.length - 1]);
      }
      continue;
    }
    for (const n of parameterNames(p)) params.add(n);
  }
  return { params, fields };
}

// A local declared inside a handler body: const m = ..., let { name } = ...,
// Lua local m = ... (the first name of a Lua list).
const LOCAL_JS_RE = /(?<![\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*|\{[^}]*\})\s*=(?![=>])\s*([^;]*)/g;
const LOCAL_LUA_DECL_RE = /(?<![\w.])local\s+([A-Za-z_][\w]*)(?:\s*,\s*[A-Za-z_][\w]*)*\s*=(?!=)\s*(.*)/g;
const DERIVED_DEPTH = 3;
// let m; or let m, n; (a JavaScript local declared without a value).
const UNINIT_JS_RE = /(?<![\w$.])(?:let|var)\s+([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)\s*(?=;|$)/g;

/**
 * The expression at the start of text: up to a ";" or "," outside its own
 * brackets, or a closing bracket it did not open (the "}" of a try block).
 */
function statementExpr(text) {
  let depth = 0;
  let inStr = null;
  let esc = false;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (--depth < 0) return text.slice(0, k);
    } else if ((c === ';' || c === ',') && depth === 0) return text.slice(0, k);
  }
  return text;
}

/**
 * Add to params (or fields, for a destructuring pattern) the locals
 * declared in the body between start and end from an expression that
 * names a parameter (const m = JSON.parse(line)), and then the locals
 * derived from those, up to DERIVED_DEPTH levels. A local from a literal
 * or from names unrelated to the parameters is not added.
 */
function derivedLocals(code, start, end, params, fields, lua) {
  const decls = [];
  const re = lua ? LOCAL_LUA_DECL_RE : LOCAL_JS_RE;
  const inBody = (li, idx) => !(li === start.line && idx <= start.col) && !(li === end.line && idx >= end.col);
  // JavaScript locals declared without a value (let m;), as name => assignments.
  const uninit = new Map();
  for (let li = start.line; li <= end.line && li < code.length; li++) {
    const line = code[li];
    re.lastIndex = 0;
    for (const m of line.matchAll(re)) {
      if (!inBody(li, m.index)) continue;
      decls.push({ target: m[1], exprs: [m[2]] });
    }
    if (lua) continue;
    for (const m of line.matchAll(UNINIT_JS_RE)) {
      if (!inBody(li, m.index)) continue;
      for (const n of m[1].split(',')) uninit.set(n.trim(), []);
    }
  }
  if (uninit.size > 0) {
    // Every later assignment to such a local (m = JSON.parse(text), even
    // inside a try block). It is derived only when all of them are.
    const assign = new RegExp('(?<![\\w$.])(' + [...uninit.keys()].map(escapeRe).join('|') + ')\\s*=(?![=>])', 'g');
    for (let li = start.line; li <= end.line && li < code.length; li++) {
      const line = code[li];
      assign.lastIndex = 0;
      for (const m of line.matchAll(assign)) {
        if (!inBody(li, m.index)) continue;
        if (/(?:let|var|const)\s+$/.test(line.slice(0, m.index))) continue;
        uninit.get(m[1]).push(statementExpr(line.slice(m.index + m[0].length)));
      }
    }
    for (const [target, exprs] of uninit) if (exprs.length > 0) decls.push({ target, exprs });
  }
  if (decls.length === 0) return;
  const known = new Set(params);
  const done = new Set();
  for (let depth = 0; depth < DERIVED_DEPTH; depth++) {
    // Only names known before this pass count, so depth 3 means three
    // levels whatever order the locals are declared in.
    const snapshot = new Set(known);
    let added = false;
    decls.forEach((d, i) => {
      if (done.has(i)) return;
      if (!d.exprs.every((e) => referencedNames(e).some((id) => snapshot.has(id)))) return;
      done.add(i);
      added = true;
      if (d.target.startsWith('{')) {
        for (const n of handlerParams(d.target).fields) fields.add(n);
      } else {
        known.add(d.target);
        params.add(d.target);
      }
    });
    if (!added) break;
  }
}

/**
 * The identifiers an expression reads: quoted strings are blanked first,
 * and an object key ({ line: 1 }, Lua { line = 1 }) or a property after a
 * dot is not a read.
 */
function referencedNames(expr) {
  const bare = expr.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
  const names = [];
  for (const m of bare.matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*/g)) {
    const rest = bare.slice(m.index + m[0].length);
    const prev = bare.slice(0, m.index).trimEnd();
    const keyish = /^\s*:(?!:)/.test(rest) || (/^\s*=(?!=)/.test(rest) && /[{,]$/.test(prev));
    if (keyish && /[{,]$/.test(prev)) continue;
    names.push(m[0]);
  }
  return names;
}

/** Index of the "(" that the ")" at closeIdx closes, or -1. */
function openParen(line, closeIdx) {
  let depth = 0;
  for (let k = closeIdx; k >= 0; k--) {
    if (line[k] === ')') depth++;
    else if (line[k] === '(' && --depth === 0) return k;
  }
  return -1;
}

/**
 * The bodies of anonymous functions passed as an argument or assigned to a
 * property in one file, and every Swift closure with named parameters, as
 * [{ params, fields, declared, start, end, iter, plain }] with 0 based lines.
 * iter says the function is the callback of an iteration method (forEach,
 * map, filter and the like), plain that the forwarding closure rule applies
 * (not Lua). Only C style files, Swift and Lua; GDScript and Python lambdas
 * are not followed.
 */
export function handlerScopes(code, rel) {
  const ext = extOf(rel);
  if (ext === 'gd' || ext === 'py') return [];
  const lua = ext === 'lua';
  const swift = ext === 'swift';
  const scopes = [];
  const isHandlerContext = (prefix) =>
    lua
      ? HANDLER_BEFORE_LUA_RE.test(prefix) && !LOCAL_LUA_RE.test(prefix)
      : HANDLER_BEFORE_JS_RE.test(prefix) || HANDLER_ASSIGN_JS_RE.test(prefix);
  const push = (list, start, end, iter = false) => {
    const { params, fields } = handlerParams(list);
    if (!(params.size || fields.size) || !end) return;
    // The plain parameters as declared, before derived locals are added,
    // for the forwarding closure rule.
    const declared = new Set(params);
    derivedLocals(code, start, end, params, fields, lua);
    scopes.push({ params, fields, declared, start, end, iter, plain: !lua });
  };
  // Names of functions assigned to a property somewhere in the file
  // (Module.print = handle; window.__rsBridge = handle), so a named
  // function declared on its own and assigned later counts as a handler.
  const assignedNames = new Set();
  if (!lua) {
    for (const line of code) {
      for (const m of line.matchAll(ASSIGNED_NAME_JS_RE)) assignedNames.add(m[1]);
    }
  }
  for (let li = 0; li < code.length; li++) {
    const line = code[li];
    // function (m) { ... } / function(m) ... end / function handle(m) { ... }
    for (const m of line.matchAll(lua ? /(?<![\w$.:])function\s*\(/g : /(?<![\w$.])function\s*\*?\s*([A-Za-z_$][\w$]*\s*)?\(/g)) {
      const declared = !lua && m[1] && assignedNames.has(m[1].trim());
      if (!declared && !isHandlerContext(line.slice(0, m.index))) continue;
      const openIdx = m.index + m[0].length - 1;
      const close = closeParen(line, openIdx);
      if (close === -1) continue;
      const end = lua ? luaEnd(code, li, close + 1) : braceEnd(code, li, close + 1);
      push(line.slice(openIdx + 1, close), { line: li, col: close }, end, !lua && ITER_JS_RE.test(line.slice(0, m.index)));
    }
    if (lua) continue;
    if (swift) {
      // { name, data in ... } and { (name: String, data: [String: Any]) in ... }
      for (const m of line.matchAll(SWIFT_CLOSURE_RE)) {
        const end = braceEnd(code, li, m.index);
        let list = m[1].trim();
        if (list.startsWith('(')) list = list.slice(1, -1);
        const inAt = m.index + m[0].length - 2;
        push(list, { line: li, col: inAt }, end, ITER_SWIFT_RE.test(line.slice(0, m.index)));
      }
      continue;
    }
    // (m) => ..., ({ name }) => ..., m => ...
    for (const m of line.matchAll(/=>/g)) {
      if (line[m.index - 1] === '=' || line[m.index - 1] === '<' || line[m.index - 1] === '>') continue;
      let k = m.index - 1;
      while (k >= 0 && /\s/.test(line[k])) k--;
      let listStart;
      let list;
      if (line[k] === ')') {
        listStart = openParen(line, k);
        if (listStart === -1) continue;
        list = line.slice(listStart + 1, k);
      } else {
        const id = /[A-Za-z_$][\w$]*$/.exec(line.slice(0, k + 1));
        if (!id) continue;
        listStart = id.index;
        list = id[0];
      }
      if (!isHandlerContext(line.slice(0, listStart))) continue;
      const end = arrowEnd(code, li, m.index + 2);
      push(list, { line: li, col: m.index + 1 }, end, ITER_JS_RE.test(line.slice(0, listStart)));
    }
  }
  return scopes;
}

// <param>.<field>, <param>['field'], <param>.data.name and the like.
const FIELD_EXPR_RE = /^([A-Za-z_$][\w$]*)((?:\s*\.\s*[A-Za-z_$][\w$]*|\s*\[\s*(['"])[^'"\\]*\3\s*\])+)$/;

/**
 * Is a call at (line, col) whose name argument is expr forwarding a field
 * of a handler's parameter? expr is <param>.<field> or <param>['field']
 * with <param> a parameter of a handler whose body holds the call, or a
 * bare name that handler's parameter list destructures.
 */
export function isHandlerForwarded(scopes, line, col, expr) {
  const at = { line, col };
  const inside = scopes.filter((s) => before(s.start, at) && before(at, s.end));
  if (inside.length === 0) return false;
  const field = FIELD_EXPR_RE.exec(expr);
  if (field) return inside.some((s) => s.params.has(field[1]));
  if (/^[A-Za-z_$][\w$]*$/.test(expr)) return inside.some((s) => s.fields.has(expr));
  return false;
}

// Forwarding closures.
//
// A closure whose parameter is the event name, passed on as the name
// argument, is a sink that forwards whatever it is given:
//   Swift  sink = { name, data in Ravensight.track(name, data) }
//   JS     bridge.send = (name, data) => rs.track(name, data)
//   JS     register((name, data) => rs.track(name, data))
// Its names come from whoever calls the sink, so the call is forwarded, the
// same rule as for a handler that forwards a field of its message. The
// callback of an iteration method is not a sink (items.forEach((n) =>
// rs.track(n)) passes names out of a list the doctor cannot read), and the
// parameter must be the closure's own: the innermost closure that declares
// it decides. A Swift $0 is not followed; name the closure in forwarders.

const ITER_JS_RE =
  /\.(?:forEach|map|flatMap|filter|reduce|reduceRight|some|every|find|findIndex|findLast|findLastIndex|sort|then)\(\s*(?:async\s+)?$/;
const ITER_SWIFT_RE =
  /\.(?:forEach|map|compactMap|flatMap|filter|reduce|sorted|sort|contains|first|last|allSatisfy|removeAll|min|max|drop|prefix)\b[^.{}]*$/;
const SWIFT_CLOSURE_RE =
  /\{\s*(?:\[[^\]]*\]\s*)?(\([^()]*\)|[A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?:(?:async\s+)?(?:throws\s+)?->\s*[^{}]*?\s*)?\s+in\b/g;

/**
 * Is a call at (line, col) whose name argument is expr passing a parameter
 * of the closure around it, where that closure is a sink (not an iteration
 * callback, not Lua)?
 */
export function isClosureForwarded(scopes, line, col, expr) {
  if (!/^[A-Za-z_$][\w$]*$/.test(expr)) return false;
  const at = { line, col };
  let best = null;
  for (const s of scopes) {
    if (!s.declared || !s.declared.has(expr)) continue;
    if (!(before(s.start, at) && before(at, s.end))) continue;
    if (best && before(s.start, best.start)) continue;
    best = s;
  }
  return Boolean(best && best.plain && !best.iter);
}

// Declared forwarders.
//
// For a sink the heuristic cannot see (a Swift closure using $0, a function
// stored and called through a variable), forwarders in ravensight.config.json
// names it: "TelemetrySink.send" or "send". A track call inside the body of
// that function or closure whose name the doctor cannot read is forwarded.
// Nothing else changes: calls to the forwarder are not track calls. A dotted
// name is matched on its last segment, in a file that declares the first part
// (class, struct, enum, extension, actor, protocol, object, const, let, var,
// function) or assigns A.b directly.

/**
 * The bodies of the named forwarders in one file, as
 * [{ name, start, end }] with 0 based lines.
 */
export function forwarderScopes(code, rel, names) {
  if (!names || names.length === 0) return [];
  const ext = extOf(rel);
  const text = code.join('\n');
  const out = [];
  for (const name of names) {
    const parts = name.split('.');
    const seg = parts.pop();
    const owner = parts.join('.');
    const segRe = escapeRe(seg);
    if (owner) {
      const head = escapeRe(owner.split('.').pop());
      const declared = new RegExp(
        `(?:\\b(?:class|struct|enum|extension|actor|protocol|object|const|let|var|function)\\s+${head}\\b)|(?<![\\w$])${escapeRe(owner)}\\.${segRe}\\s*=(?![=>])`,
      );
      if (!declared.test(text)) continue;
    }
    const defRe = new RegExp(`(?<![\\w$])(?:func|function|def|fun|fn)\\s+${segRe}\\s*(?:<[^>]*>)?\\(`, 'g');
    const assignRe = new RegExp(`(?<![\\w$])${segRe}\\s*(?::(?!:)[^=;{]*?)?=(?![=>])\\s*`, 'g');
    const keyRe = new RegExp(`(?<![\\w$])${segRe}\\s*:\\s*(?=(?:async\\s*)?(?:\\(|function\\b|[A-Za-z_$][\\w$]*\\s*=>))`, 'g');
    for (let li = 0; li < code.length; li++) {
      const line = code[li];
      for (const m of line.matchAll(defRe)) {
        const openIdx = m.index + m[0].length - 1;
        const close = closeParen(line, openIdx);
        if (close === -1) continue;
        let end;
        if (ext === 'gd' || ext === 'py') end = indentEnd(code, li);
        else if (ext === 'lua') end = luaEnd(code, li, close + 1);
        else end = braceEnd(code, li, close + 1);
        if (end) out.push({ name, start: { line: li, col: close }, end });
      }
      for (const re of [assignRe, keyRe]) {
        for (const m of line.matchAll(re)) {
          const at = m.index + m[0].length;
          const rest = line.slice(at);
          let end = null;
          if (rest[0] === '{') end = braceEnd(code, li, at);
          else if (/^(?:async\s+)?function\b/.test(rest)) {
            const open = line.indexOf('(', at);
            const close = open === -1 ? -1 : closeParen(line, open);
            if (close !== -1) end = ext === 'lua' ? luaEnd(code, li, close + 1) : braceEnd(code, li, close + 1);
          } else {
            const arrow = /=>/.exec(rest);
            if (arrow) end = arrowEnd(code, li, at + arrow.index + 2);
          }
          if (end) out.push({ name, start: { line: li, col: at }, end });
        }
      }
    }
  }
  return out;
}

/** The forwarder whose body holds the call at (line, col), or null. */
export function forwarderAround(scopes, line, col) {
  const at = { line, col };
  const s = scopes.find((f) => before(f.start, at) && before(at, f.end));
  return s ? s.name : null;
}

// Swift functions, for the forwarding hint.
//
// In Swift a wrapper often forwards to another wrapper:
//   func emit(_ name: String, _ props: [String: Any] = [:]) { Ravensight.track(name, props) }
//   func emitOnce(key: String, _ name: String) { ...; emit(name) }
// With only emit named, the inner emit(name) is unresolved. The call sits in
// a function that has the name as a parameter, so that function is a track
// wrapper too, and the doctor can say which --track-fn entry to add.

/**
 * The parameters of a Swift parameter list in order, as
 * [{ label, name }] where label is the external label ("_" when the
 * argument is unlabelled) and name the internal name.
 */
export function swiftParams(list) {
  const out = [];
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
  for (const p of parts) {
    let head = p;
    const colon = head.indexOf(':');
    if (colon === -1) continue;
    head = head.slice(0, colon);
    const ids = head.match(/[A-Za-z_][\w]*/g);
    if (!ids) continue;
    const name = ids[ids.length - 1];
    const label = ids.length > 1 ? ids[ids.length - 2] : name;
    out.push({ label, name });
  }
  return out;
}

const SWIFT_FUNC_RE = /(?<![\w$])func\s+([A-Za-z_][\w]*)\s*(?:<[^>]*>)?\s*\(/g;

/**
 * The Swift functions defined in one file, as
 * [{ name, params, start, end, nested }] with 0 based lines; nested is true
 * when the definition is indented (a method inside a type or extension).
 */
export function swiftFunctions(code) {
  const found = [];
  for (let li = 0; li < code.length; li++) {
    const line = code[li];
    SWIFT_FUNC_RE.lastIndex = 0;
    for (const m of line.matchAll(SWIFT_FUNC_RE)) {
      const openIdx = m.index + m[0].length - 1;
      const close = closeParen(line, openIdx);
      if (close === -1) continue;
      const end = braceEnd(code, li, close + 1);
      if (!end) continue;
      found.push({
        name: m[1],
        params: swiftParams(line.slice(openIdx + 1, close)),
        start: { line: li, col: close },
        end,
        nested: /^\s+/.test(line),
      });
    }
  }
  return found;
}

/**
 * The --track-fn suggestion for a Swift call at (line, col) that passes
 * ident: the innermost function around it with ident as a parameter, as
 * { fn, argIndex, label, spec, nested }, or null.
 */
export function swiftForwardSuggestion(fns, line, col, ident) {
  const at = { line, col };
  let best = null;
  for (const f of fns) {
    if (!(before(f.start, at) && before(at, f.end))) continue;
    if (best && before(f.start, best.start)) continue;
    best = f;
  }
  if (!best) return null;
  const idx = best.params.findIndex((p) => p.name === ident);
  if (idx === -1) return null;
  return {
    fn: best.name,
    argIndex: idx,
    label: best.params[idx].label,
    spec: idx === 0 ? best.name : `${best.name}@${idx}`,
    nested: best.nested,
  };
}
