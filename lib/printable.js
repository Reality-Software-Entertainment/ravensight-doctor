// One sanitiser for every server provided string the doctor prints.
//
// A game name, slug or environment label, a server error message or a
// timestamp comes from the API and reaches the terminal. A crafted value
// with ANSI escapes, control characters, bidi overrides or zero width
// characters could move the cursor, recolour or reorder the report and
// spoof its own labels. printable() removes all of those and bounds the
// length. JSON output keeps the raw value; only what is printed passes here.

export const PRINT_MAX = 80;

// ESC sequences: CSI (ESC [ ... final), OSC (ESC ] ... BEL or ESC \), and
// the two character forms (ESC and one byte), plus the 8 bit CSI and OSC.
const ESC_SEQ_RE =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[ -~]?|\u009b[0-?]*[ -/]*[@-~]|\u009d[^\u0007\u001b\u009c]*(?:\u0007|\u009c)?/g;
// C0 controls, DEL and C1 controls.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
// Bidi marks, embeddings, overrides and isolates; zero width characters.
const INVISIBLE_RE = /[؜​-‏‪-‮⁠-⁩᠎﻿]/g;

/**
 * value as text that is safe to print: ESC sequences, C0 and C1 controls,
 * bidi and zero width characters removed, whitespace runs collapsed, and
 * at most max characters (code points), ending in "..." when cut.
 */
export function printable(value, max = PRINT_MAX) {
  if (value == null) return '';
  const s = String(value)
    .replace(ESC_SEQ_RE, '')
    .replace(CONTROL_RE, ' ')
    .replace(INVISIBLE_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return chars.slice(0, Math.max(0, max - 3)).join('') + '...';
}
