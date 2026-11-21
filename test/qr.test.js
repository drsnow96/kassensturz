'use strict';
// QR-Erzeugung: Größe je Version und Suchmuster (Dekodierung wurde mit OpenCV geprüft)
const { test } = require('node:test');
const assert = require('node:assert');
const qr = require('../public/qr.js');

test('Version wächst mit der Länge, Suchmuster sitzen in den Ecken', () => {
  assert.equal(qr.matrix('A').length, 21);
  const m = qr.matrix('https://ds723.example.ts.net:8099/#teil-K7Q2XP');
  assert.ok(m.length >= 29 && m.length <= 37);
  const n = m.length;
  for (const [x, y] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
    assert.equal(m[y][x], true); assert.equal(m[y + 1][x + 1], false); assert.equal(m[y + 3][x + 3], true);
  }
  assert.equal(qr.matrix('y'.repeat(200)).length, 57);
  assert.throws(() => qr.matrix('z'.repeat(400)));
  assert.match(qr.svg('Test'), /^<svg[^>]+viewBox="0 0 29 29"/);
});
