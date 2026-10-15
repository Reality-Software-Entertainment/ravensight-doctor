// Literal props at a call site, for the contract's static check.
//
// Given a call whose "(" sits at (line, openIdx) in comment stripped code,
// collect the call's argument text (across lines, bounded), split it into
// top level arguments, and read the keys of the first literal object or
// dictionary after the event name argument: a JavaScript, GDScript or Lua
// "{ ... }" or a Swift "[ "key": value ]". Anything the doctor cannot read
// for certain (a spread, a computed key, a call that builds the props, no
// props argument at all) gives null, and the call is simply not checked.

const MAX_CALL_LINES = 200;
const MAX_CALL_CHARS = 64 * 1024;

/** The text between a call's "(" and its matching ")", or null when it never closes in bounds. */
export function callArgsText(code, li, openIdx) {
  let depth = 0;
  let inStr = null;
  let esc = false;
  let out = '';
  for (let i = li; i < code.length && i < li + MAX_CALL_LINES; i++) {
    const line = code[i];
    for (let k = i === li ? openIdx : 0; k < line.length; k++) {
      const c = line[k];
      if (out.length > MAX_CALL_CHARS) return null;
      if (inStr) {
        out += c;
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === inStr) inStr = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        inStr = c;
        out += c;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') {
        depth++;
        if (depth === 1) continue; // the call's own "("
      } else if (c === ')' || c === ']' || c === '}') {
        depth--;
        if (depth === 0) return out;
      }
      out += c;
    }
    out += '\n';
    inStr = null; // strings are followed within one line only
  }
  return null;
}

/** Split text on commas outside strings and brackets. */
export function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let inStr = null;
  let esc = false;
  let cur = '';
  for (const c of text) {
    if (inStr) {
      cur += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  parts.push(cur);
  return parts;
}

// A Swift or C# argument label, "name: value" (never "::").
const LABEL_RE = /^[A-Za-z_][\w]*\s*:(?!:)\s*/;
const LABELLED_EXTS = new Set(['swift', 'cs']);

/**
 * The argument without its label in a language with labelled arguments
 * (Swift, C#): name: "level_start" gives "level_start". Other languages
 * keep the text as is, since "a:b(" is a Lua method call there.
 */
export function stripArgLabel(expr, ext) {
  if (!LABELLED_EXTS.has(ext)) return expr;
  const m = LABEL_RE.exec(expr);
  if (!m) return expr;
  // "cond ? a : b" starts with an identifier and then "?", never ":".
  return expr.slice(m[0].length);
}

/** Does a top level ":" appear in text (outside strings and brackets)? */
function hasTopLevelColon(text) {
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
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ':' && depth === 0 && text[k + 1] !== ':' && text[k - 1] !== ':') return true;
  }
  return false;
}

const QUOTED_KEY_RE = /^(["'])((?:\\.|(?!\1)[^\\])*)\1\s*(?::|=(?![=>]))/;
const BRACKET_KEY_RE = /^\[\s*(["'])((?:\\.|(?!\1)[^\\])*)\1\s*\]\s*(?::|=(?!=))/;
const IDENT_KEY_RE = /^([A-Za-z_$][\w$]*)\s*(?::(?!:)|=(?![=>]))/;
const SHORTHAND_RE = /^[A-Za-z_$][\w$]*$/;

/**
 * The keys of one literal object or dictionary, or null when it is not one
 * the doctor can read for certain. text is the whole literal, brackets
 * included.
 */
export function literalKeys(text) {
  const t = text.trim();
  const open = t[0];
  const close = t[t.length - 1];
  if (!((open === '{' && close === '}') || (open === '[' && close === ']'))) return null;
  const body = t.slice(1, -1);
  if (open === '[') {
    if (body.trim() === ':') return []; // Swift [:]
    if (!hasTopLevelColon(body)) return null; // an array, not a dictionary
  }
  const keys = [];
  for (const raw of splitTopLevel(body)) {
    const e = raw.trim();
    if (e === '') continue;
    let m = QUOTED_KEY_RE.exec(e) || BRACKET_KEY_RE.exec(e);
    if (m) {
      keys.push(m[2]);
      continue;
    }
    m = IDENT_KEY_RE.exec(e);
    if (m) {
      keys.push(m[1]);
      continue;
    }
    if (open === '{' && SHORTHAND_RE.test(e)) {
      keys.push(e); // { run_id }
      continue;
    }
    return null; // a spread, a computed key or something else unreadable
  }
  return keys;
}

/**
 * The keys of the first literal props argument after the event name
 * argument (argIndex) of the call at (li, openIdx), or null when there is
 * none the doctor can read.
 */
export function callPropKeys(code, li, openIdx, argIndex, ext) {
  const text = callArgsText(code, li, openIdx);
  if (text == null) return null;
  const args = splitTopLevel(text);
  for (let i = argIndex + 1; i < args.length; i++) {
    const a = stripArgLabel(args[i].trim(), ext);
    if (a[0] !== '{' && a[0] !== '[') continue;
    const keys = literalKeys(a);
    if (keys) return keys;
    if (a[0] === '{') return null; // an object the doctor cannot read
  }
  return null;
}
