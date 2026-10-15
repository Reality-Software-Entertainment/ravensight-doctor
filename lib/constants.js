// Event names from simple constant members: capture(EVENTS.registered)
// where a JavaScript or TypeScript file declares
//   const EVENTS = { registered: 'registered', ... }        (or as const,
//   export const EVENTS = Object.freeze({ ... }))
// One level only: the member's value must be a plain string literal in the
// object literal itself. The same file is looked up first; otherwise a
// scanned file that exports the name (export const NAME, or export { NAME })
// is used when the calling file imports it by name, and only when every
// exporting file agrees on the value. Anything else stays unresolved.

import { splitTopLevel } from './props.js';

export const CONSTANT_EXTS = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts']);

const DECL_RE = /(?<![\w$.])(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:Object\.freeze\(\s*)?(?=\{)/g;
const EXPORT_LIST_RE = /(?<![\w$.])export\s*\{([^}]*)\}/g;
const PIECE_RE = /^\s*(?:(["'])([\w$-]+)\1|([A-Za-z_$][\w$]*))\s*:\s*(["'`])((?:\\.|(?!\4)[^\\])*)\4\s*$/;
const MAX_OBJECT_CHARS = 64 * 1024;

/** The body of the object literal starting at text[at] === '{', or null. */
function objectBody(text, at) {
  let depth = 0;
  let inStr = null;
  let esc = false;
  for (let k = at; k < text.length && k - at < MAX_OBJECT_CHARS; k++) {
    const c = text[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') {
      if (--depth === 0) return text.slice(at + 1, k);
    }
  }
  return null;
}

/**
 * The object constants a file declares, as Map(name => { exported, values:
 * Map(key => { quote, content }) }). text is comment stripped source.
 */
export function objectConstants(text) {
  const out = new Map();
  for (const m of text.matchAll(DECL_RE)) {
    const body = objectBody(text, m.index + m[0].length);
    if (body == null) continue;
    const values = new Map();
    for (const piece of splitTopLevel(body)) {
      const p = PIECE_RE.exec(piece);
      if (!p) continue;
      if (p[4] === '`' && p[5].includes('${')) continue;
      values.set(p[2] || p[3], { quote: p[4], content: p[5] });
    }
    if (values.size === 0) continue;
    out.set(m[2], { exported: Boolean(m[1]), values });
  }
  for (const m of text.matchAll(EXPORT_LIST_RE)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (out.has(name)) out.get(name).exported = true;
    }
  }
  return out;
}

/** Does text import name by name (import { NAME } from, or a require destructure)? */
export function importsName(text, name) {
  const n = name.replace(/[$]/g, '\\$');
  return new RegExp(
    `\\bimport\\s*(?:type\\s+)?(?:[\\w$]+\\s*,\\s*)?\\{[^}]*(?<![\\w$])${n}(?![\\w$])(?!\\s+as\\b)[^}]*\\}\\s*from\\b` +
      `|\\{[^}]*(?<![\\w$])${n}(?![\\w$])[^}]*\\}\\s*=\\s*require\\(`,
  ).test(text);
}

const MEMBER_RE = /^([A-Za-z_$][\w$]*)\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(["'])([\w$-]+)\3\s*\])$/;

/**
 * Resolve expr (EVENTS.registered or EVENTS['registered']) to the string
 * literal it names. local is the calling file's objectConstants, exported
 * a Map(name => [{ file, values }]) over every scanned file, text the
 * calling file's text and rel its path. Returns { quote, content, from }
 * or null.
 */
export function resolveConstant(expr, { local, exported, text, rel }) {
  const m = MEMBER_RE.exec(expr.trim());
  if (!m) return null;
  const [, obj] = m;
  const key = m[2] || m[4];
  const from = `${obj}.${key}`;
  const own = local && local.get(obj);
  if (own) {
    const v = own.values.get(key);
    return v ? { ...v, from } : null;
  }
  const decls = (exported && exported.get(obj)) || [];
  const others = decls.filter((d) => d.file !== rel);
  if (others.length === 0 || !importsName(text, obj)) return null;
  const found = others.map((d) => d.values.get(key));
  if (found.some((v) => !v)) return null;
  if (new Set(found.map((v) => v.content)).size !== 1) return null;
  return { ...found[0], from };
}
