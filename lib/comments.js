// Comment stripping for the track call scan.
//
// Comments are replaced with spaces, never removed, and newlines are always
// kept, so every line and column in the stripped text matches the original
// file. Quoted strings are followed within a single line only, so a comment
// marker inside "..." , '...' or `...` on one line is left alone; a marker
// inside a string that spans lines (template literals, Python triple quotes,
// Lua long strings) can be mistaken for a comment. Files whose extension is
// not listed here are not stripped at all.
//
// JavaScript and TypeScript files (and the scripts in HTML, Vue and Svelte
// files) also follow regex literals on one line, so a quote or a "/*"
// inside /'/g or /\/*$/ is read as part of the regex, and a "'" right after
// a letter or digit (JSX text such as Don't) does not open a string. A "/*"
// outside a string or regex always opens a block comment, which runs to its
// "*/" on a later line if need be; only a "/*" right after a backslash (an
// escaped slash in a regex the scanner did not recognise) is left alone.
// The other C style languages have no regex literals, so the same rule
// holds there.
//
// An HTML page (.html, .htm) keeps only the text inside its JavaScript
// <script> elements (no type, type="module", or a javascript or ecmascript
// type): the markup, the page text, every <!-- --> comment and every other
// script type (JSON, importmap, templates) are blanked, and each kept
// script body is stripped as JavaScript.
//
// A Vue or Svelte single file component (.vue, .svelte) keeps its markup,
// because template handlers such as @click="capture('x')" are real calls,
// and blanks its <!-- --> comments and <style> blocks. Its <script> blocks
// (JavaScript or TypeScript, by type or lang) are stripped as JavaScript;
// any other script language is blanked.

const JS_STYLE = new Set(['js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'tsx', 'jsx']);
const C_STYLE = new Set(['cs', 'swift', 'kt', 'java', 'odin', 'c', 'cc', 'cpp', 'h', 'hpp']);
const HASH_STYLE = new Set(['gd', 'py', 'rb', 'sh']);
const LUA_STYLE = new Set(['lua']);
const HTML_STYLE = new Set(['html', 'htm']);
const SFC_STYLE = new Set(['vue', 'svelte']);

export function extOf(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** The comment syntax for a file path: 'js', 'c', 'hash', 'lua', 'html', 'sfc' or null. */
export function commentStyle(rel) {
  const ext = extOf(rel);
  if (JS_STYLE.has(ext)) return 'js';
  if (C_STYLE.has(ext)) return 'c';
  if (HASH_STYLE.has(ext)) return 'hash';
  if (LUA_STYLE.has(ext)) return 'lua';
  if (HTML_STYLE.has(ext)) return 'html';
  if (SFC_STYLE.has(ext)) return 'sfc';
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
  if (style === 'html') return stripHtml(text);
  if (style === 'sfc') return stripSfc(text);
  return stripStyle(text, style);
}

/**
 * Keep only the bodies of an HTML page's <script> elements, with their
 * comments stripped as JavaScript; everything else becomes spaces. Newlines
 * and the length of the text are kept.
 */
function stripHtml(text) {
  const out = text.split('').map(blank);
  const open = /<!--|<script(?=[\s>/])[^>]*>/gi;
  let m;
  while ((m = open.exec(text)) !== null) {
    if (m[0] === '<!--') {
      const close = text.indexOf('-->', m.index + 4);
      if (close === -1) break;
      open.lastIndex = close + 3;
      continue;
    }
    const start = m.index + m[0].length;
    const scanned = isJsScript(m[0]);
    const closeRe = /<\/script\s*>/gi;
    closeRe.lastIndex = start;
    const close = closeRe.exec(text);
    const end = close ? close.index : text.length;
    if (scanned) {
      const body = stripStyle(text.slice(start, end), 'js');
      for (let k = 0; k < body.length; k++) out[start + k] = body[k];
    }
    if (!close) break;
    open.lastIndex = close.index + close[0].length;
  }
  return out.join('');
}

/** The value of attribute name in a tag, lowercased, or null. */
function attr(tag, name) {
  const m = new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '').trim().toLowerCase() : null;
}

/**
 * Is this <script ...> tag JavaScript: no type, type="module", or a
 * javascript or ecmascript type? JSON, importmap, templates and every
 * other type are not scanned.
 */
function isJsScript(tag) {
  const type = attr(tag, 'type');
  return type === null || type === '' || type === 'module' || /javascript|ecmascript/.test(type);
}

/**
 * Is this component <script ...> tag JavaScript or TypeScript: a JavaScript
 * type (see isJsScript) and no lang, or lang js, ts, jsx or tsx?
 */
function isSfcScript(tag) {
  const lang = attr(tag, 'lang');
  return isJsScript(tag) && (lang === null || ['', 'js', 'ts', 'jsx', 'tsx', 'javascript', 'typescript'].includes(lang));
}

/**
 * A Vue or Svelte component: markup kept, <!-- --> comments and <style>
 * blocks blanked, <script> blocks stripped as JavaScript (or blanked when
 * they are another language). Newlines and the length are kept.
 */
function stripSfc(text) {
  const out = text.split('');
  const fill = (from, to) => {
    for (let k = from; k < to; k++) out[k] = blank(text[k]);
  };
  const open = /<!--|<(script|style)(?=[\s>/])[^>]*>/gi;
  let m;
  while ((m = open.exec(text)) !== null) {
    if (m[0] === '<!--') {
      const close = text.indexOf('-->', m.index + 4);
      const end = close === -1 ? text.length : close + 3;
      fill(m.index, end);
      if (close === -1) break;
      open.lastIndex = end;
      continue;
    }
    const tagName = m[1].toLowerCase();
    const start = m.index + m[0].length;
    const closeRe = new RegExp('</' + tagName + '\\s*>', 'gi');
    closeRe.lastIndex = start;
    const close = closeRe.exec(text);
    const end = close ? close.index : text.length;
    if (tagName === 'script' && isSfcScript(m[0])) {
      const body = stripStyle(text.slice(start, end), 'js');
      for (let k = 0; k < body.length; k++) out[start + k] = body[k];
    } else {
      fill(start, end);
    }
    if (!close) break;
    open.lastIndex = close.index + close[0].length;
  }
  return out.join('');
}

function stripStyle(text, style) {
  const out = text.split('');
  const n = text.length;
  const cLike = style === 'c' || style === 'js';
  const js = style === 'js';
  let i = 0;
  let inStr = null;
  let esc = false;
  // The last character outside whitespace and comments, and the word it
  // ends, for telling a regex literal from a division.
  let prev = '';
  let prevWord = '';
  while (i < n) {
    const c = text[i];
    if (c === '\n') {
      // Strings are only followed within one line.
      inStr = null;
      esc = false;
      prev = '';
      prevWord = '';
      i++;
      continue;
    }
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      if (!inStr) prev = c;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || (c === '`' && cLike)) {
      // In JavaScript a quote right after a letter or digit is not a string
      // opener (JSX text such as Don't); code never puts one there.
      if (!(js && c === "'" && /[A-Za-z0-9]/.test(text[i - 1] || ''))) {
        inStr = c;
      }
      i++;
      continue;
    }
    let end = -1; // index just past the comment
    if (cLike && c === '/' && text[i + 1] === '/') {
      end = lineEnd(text, i);
    } else if (cLike && c === '/' && text[i + 1] === '*') {
      if (text[i - 1] !== '\\') {
        const close = text.indexOf('*/', i + 2);
        end = close === -1 ? n : close + 2;
      }
      // After a backslash, "/*" is an escaped slash in a regex literal the
      // scanner did not recognise (such as /a\/*b/ after a ")").
    } else if (js && c === '/' && regexAllowed(prev, prevWord)) {
      const close = regexEnd(text, i);
      if (close !== -1) {
        i = close;
        prev = '/';
        prevWord = '';
        continue;
      }
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
      if (c !== ' ' && c !== '\t' && c !== '\r') {
        if (/[\w$]/.test(c)) prevWord = /[\w$]/.test(prev) ? prevWord + c : c;
        else prevWord = '';
        prev = c;
      }
      i++;
      continue;
    }
    for (let k = i; k < end; k++) out[k] = blank(text[k]);
    // A block comment that spans lines leaves the scanner on a later line.
    if (text.lastIndexOf('\n', end - 1) >= i) {
      prev = '';
      prevWord = '';
    }
    i = end;
  }
  return out.join('');
}

// Characters after which a "/" starts a regex literal rather than a
// division: an operator, an opening bracket, a separator, or nothing at
// all (line start). Keywords after which an expression starts count too.
const REGEX_AFTER = new Set('=(,;{}:?!&|+-*%<>~^['.split(''));
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);

function regexAllowed(prev, prevWord) {
  if (prev === '') return true;
  if (REGEX_AFTER.has(prev)) return true;
  return prevWord !== '' && REGEX_AFTER_WORD.has(prevWord);
}

/**
 * Index just past the flags of the regex literal whose opening "/" is at i,
 * or -1 when it does not close on its line (then it was a division).
 */
function regexEnd(text, i) {
  let inClass = false;
  for (let k = i + 1; k < text.length; k++) {
    const c = text[k];
    if (c === '\n') return -1;
    if (c === '\\') {
      k++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
    } else if (c === '[') inClass = true;
    else if (c === '/') {
      let e = k + 1;
      while (e < text.length && /[A-Za-z]/.test(text[e])) e++;
      return e;
    }
  }
  return -1;
}

function lineEnd(text, i) {
  const nl = text.indexOf('\n', i);
  return nl === -1 ? text.length : nl;
}
