// 0.4.2: the one sanitiser for printed server strings.

import test from 'node:test';
import assert from 'node:assert/strict';
import { printable, PRINT_MAX } from '../lib/printable.js';
import { keyBelongsTo } from '../lib/live.js';

test('printable strips ESC sequences, C0 and C1 controls, bidi and zero width characters', () => {
  assert.equal(printable('\u001b[31mred\u001b[0m'), 'red');
  assert.equal(printable('a\u001b]0;title\u0007b'), 'ab');
  assert.equal(printable('a\u001b]8;;http://x\u001b\\b'), 'ab');
  assert.equal(printable('x\u009b31my\u0085z'), 'xy z');
  assert.equal(printable('line\r\nnext\tend\u0000'), 'line next end');
  assert.equal(printable('‮evil‬⁦⁩​‍﻿ok؜'), 'evilok');
  assert.equal(printable('\u001b'), '');
  assert.equal(printable(null), '');
  assert.equal(printable(42), '42');
});

test('printable bounds the length to 80 code points', () => {
  assert.equal(PRINT_MAX, 80);
  const out = printable('é'.repeat(200));
  assert.equal(Array.from(out).length, 80);
  assert.ok(out.endsWith('...'));
  assert.equal(printable('😀'.repeat(100)).startsWith('😀'), true);
  assert.equal(Array.from(printable('😀'.repeat(100))).length, 80);
  assert.equal(printable('short'), 'short');
});

test('keyBelongsTo prints each server value through printable', () => {
  const line = keyBelongsTo({ name: '\u001b[1AOK‮', slug: 'a\u0000b', environment: '​' });
  assert.equal(line, 'key belongs to OK (a b, (blank))');
  assert.equal(keyBelongsTo(null), null);
});
