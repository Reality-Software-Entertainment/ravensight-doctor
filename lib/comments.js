// Comment stripping for the track call scan.
//
// Comments are replaced with spaces, never removed, and newlines are always
// kept, so every line and column in the stripped text matches the original
// file. Quoted strings are followed within a single line only, so a comment
// marker inside "..." , '...' or `...` on one line is left alone; a marker
// inside a string that spans lines (template literals, Python triple quotes,
// Lua long strings) can be mistaken for a comment. Files whose extension is
// not listed here are not stripped at all.

const C_STYLE = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'cs', 'swift', 'kt', 'java', 'odin', 'c', 'cc', 'cpp', 'h', 'hpp']);
const HASH_STYLE = new Set(['gd', 'py', 'rb', 'sh']);
const LUA_STYLE = new Set(['lua']);

function extOf(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** The comment syntax for a file path: 'c', 'hash', 'lua' or null. */
export function commentStyle(rel) {
  const ext = extOf(rel);
  if (C_STYLE.has(ext)) return 'c';
  if (HASH_STYLE.has(ext)) return 'hash';
  if (LUA_STYLE.has(ext)) return 'lua';
  return null;
}

function blank(ch) {
  return ch === '\n' || ch === '\r' ? ch : ' ';
}

/**
 * Return text with every comment replaced by spaces, keeping newlines and
 * the length of the text, so line and column numbers stay the same.
 * Unknown file types are returned unchanged.
 */
export function stripComments(text, rel) {
  const style = commentStyle(rel);
  if (!style) return text;
  const out = text.split('');
  const n = text.length;
  let i = 0;
  let inStr = null;
  let esc = false;
  while (i < n) {
    const c = text[i];
    if (c === '\n') {
      // Strings are only followed within one line.
      inStr = null;
      esc = false;
      i++;
      continue;
    }
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || (c === '`' && style === 'c')) {
      inStr = c;
      i++;
      continue;
    }
    let end = -1; // index just past the comment
    if (style === 'c' && c === '/' && text[i + 1] === '/') {
      end = lineEnd(text, i);
    } else if (style === 'c' && c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      end = close === -1 ? n : close + 2;
    } else if (style === 'hash' && c === '#') {
      end = lineEnd(text, i);
    } else if (style === 'lua' && c === '-' && text[i + 1] === '-') {
      const long = /^\[(=*)\[/.exec(text.slice(i + 2, i + 2 + 64));
      if (long) {
        const closer = ']' + long[1] + ']';
        const close = text.indexOf(closer, i + 2 + long[0].length);
        end = close === -1 ? n : close + closer.length;
      } else {
        end = lineEnd(text, i);
      }
    }
    if (end === -1) {
      i++;
      continue;
    }
    for (let k = i; k < end; k++) out[k] = blank(text[k]);
    i = end;
  }
  return out.join('');
}

function lineEnd(text, i) {
  const nl = text.indexOf('\n', i);
  return nl === -1 ? text.length : nl;
}
