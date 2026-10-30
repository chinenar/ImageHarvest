'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { score } = require('../scripts/score-ocr-vertical-transcription.cjs');
const bbox = { x0: 0, y0: 0, x1: 40, y1: 100 };
const reference = { units: [{ id: 'speech', box: [0, 0, 40, 100], text: '右列左列', columns: ['右列', '左列'] }] };
const row = { id: 'r', bbox, text: '右列左列' };
test('vertical scoring distinguishes correct reading order from reversed columns', () => {
  assert.equal(score([row], reference).completeLexicalReadings, 1);
  assert.equal(score([{ ...row, text: '左列右列' }], reference).completeLexicalReadings, 0);
});
test('punctuation additions remain errors even with a correct lexical sequence', () => {
  const result = score([{ ...row, text: '「右列左列」' }], reference);
  assert.equal(result.completeLexicalReadings, 1);
  assert.equal(result.exact, 0);
});
test('duplicates and partial evidence cannot count as a complete reading', () => {
  assert.equal(score([row, { ...row, id: 'duplicate' }], reference).completeLexicalReadings, 0);
  assert.equal(score([{ ...row, partialReadingEvidence: { confirmed: true } }], reference).completeLexicalReadings, 0);
});
test('a matching answer at a foreign position cannot hide a missing unit', () => {
  const result = score([{ ...row, bbox: { x0: 200, y0: 0, x1: 240, y1: 100 } }], reference);
  assert.equal(result.completeLexicalReadings, 0);
  assert.equal(result.lexicalCer, 1);
});
