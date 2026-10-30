'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { recoverJapaneseLines: recoveredJapaneseLines } = require('../src/ocr-japanese-line-recovery.cjs');
const { contentRole, translationEligible } = require('../src/ocr-content-role.cjs');
const b = (x0 = 10, y0 = 20, x1 = 40, y1 = 120) => ({ x0, y0, x1, y1 });
const probe = (text, confidence, fingerprint, bbox = b(), extra = {}) => ({
  engine: 'paddleocr', inferenceFingerprint: fingerprint, variant: fingerprint,
  textLines: [{ text, confidence, bbox, ...extra }],
});

test('repeated two-character CJK headings need two positioned readings of at least 90', () => {
  const probes = [probe('第三', 99, 'a'), probe('第三', 92, 'b', b(11, 21, 41, 121))];
  const result = recoveredJapaneseLines(probes);
  assert.equal(result.length, 1);
  assert.equal(result[0].text, '第三');
  assert.deepEqual(result[0].bbox, probes[0].textLines[0].bbox);
  assert.deepEqual(result[0].recoveryEvidence.map(r => r.inferenceFingerprint), ['a', 'b']);
  assert.equal(recoveredJapaneseLines([probes[0], probe('第三', 89.9, 'b')]).length, 0);
});

test('longer CJK lines need 85 in each reading and 90 in at least one', () => {
  assert.equal(recoveredJapaneseLines([probe('明都学園', 87.8, 'a'), probe('明都学園', 95.2, 'b')]).length, 1);
  assert.equal(recoveredJapaneseLines([probe('明都学園', 89, 'a'), probe('明都学園', 89, 'b')]).length, 0);
  assert.equal(recoveredJapaneseLines([probe('明都学園', 84.9, 'a'), probe('明都学園', 99, 'b')]).length, 0);
});

test('one inference cannot become two votes through copied variants or repeated lines', () => {
  const first = probe('第三', 99, 'same');
  assert.equal(recoveredJapaneseLines([first]).length, 0);
  assert.equal(recoveredJapaneseLines([first, { ...first, variant: 'contrast' }]).length, 0);
  assert.equal(recoveredJapaneseLines([{ ...first, textLines: [...first.textLines, ...first.textLines] }]).length, 0);
  assert.equal(recoveredJapaneseLines([{ ...first, inferenceFingerprint: undefined }, probe('第三', 99, 'b')]).length, 0);
});

test('agreement requires the same positioned text and excludes Latin and lone glyphs', () => {
  for (const text of ['園', 'SCHOOL', '学園A', '学園!']) {
    assert.equal(recoveredJapaneseLines([probe(text, 99, 'a'), probe(text, 99, 'b')]).length, 0);
  }
  assert.equal(recoveredJapaneseLines([probe('第三', 99, 'a'), probe('第二', 99, 'b')]).length, 0);
  assert.equal(recoveredJapaneseLines([probe('第三', 99, 'a'), probe('第三', 99, 'b', b(100, 20, 130, 120))]).length, 0);
  assert.equal(recoveredJapaneseLines([probe('第三', 99, 'a'), { ...probe('第三', 99, 'b'), error: 'failed' }]).length, 0);
});

test('normalization matches source lines while preserving the selected text and polygon', () => {
  const polygon = [[10, 20], [40, 20], [40, 120], [10, 120]];
  const result = recoveredJapaneseLines([probe('第 三', 99, 'a', b(), { polygon }),
    probe('第三', 98, 'b', b(), { polygon: [...polygon].reverse() })]);
  assert.equal(result.length, 1);
  assert.equal(result[0].text, '第 三');
  assert.deepEqual(result[0].polygon, polygon);
});

test('conflicting polygons cannot agree solely because their bounding boxes match', () => {
  const bbox = b(0, 0, 100, 100);
  const slash = [[0, 0], [10, 0], [100, 90], [100, 100]];
  const backslash = [[90, 0], [100, 0], [10, 100], [0, 100]];
  assert.equal(recoveredJapaneseLines([probe('第三', 99, 'a', bbox, { polygon: slash }),
    probe('第三', 99, 'b', bbox, { polygon: backslash })]).length, 0);
});

test('deduplication retains a separate identical heading at another source position', () => {
  const result = recoveredJapaneseLines([probe('第三', 99, 'a'), probe('第三', 98, 'b'),
    probe('第三', 97, 'c', b(100, 20, 130, 120)), probe('第三', 96, 'd', b(100, 20, 130, 120))]);
  assert.equal(result.length, 2);
});

test('retained source lines recover a heading without endorsing the composed low-confidence column', () => {
  const probes = [probe('第三回', 84, 'a'), probe('第三回', 83, 'b')].map((r, i) => ({
    ...r, lines: [{ text: '第三', confidence: 99 - i, bbox: b() },
      { text: '回', confidence: 70, bbox: b(10, 120, 40, 140) }],
  }));
  const result = recoveredJapaneseLines(probes);
  assert.equal(result.length, 1);
  assert.equal(result[0].text, '第三');
});

test('a partial Japanese recovery stays excluded until reviewed or explicitly overridden', () => {
  const region = { text: '第三', bbox: b(), confidence: 99, partialReadingEvidence: true };
  assert.deepEqual(contentRole(region), {
    role: 'uncertain', reason: 'incomplete-japanese-reading-needs-review', excluded: true,
  });
  assert.equal(translationEligible(region), false);
  assert.equal(translationEligible({ ...region, reviewed: true }), true);
  assert.equal(translationEligible({ ...region, contentOverride: true }), true);
});

test('partial recovery cannot disappear into an automatic merged reading', () => {
  const {resolveReadingUnits}=require('../src/reading-units.cjs');
  const rows=[
    {id:'partial',text:'第三',bbox:b(),partialReadingEvidence:true,recognitionLines:[{text:'第三',bbox:b(),confidence:99}]},
    {id:'complete',text:'第三回',bbox:b(),recognitionLines:[{text:'第三回',bbox:b(),confidence:99}]},
  ];
  const placements=rows.map(r=>({id:r.id,placement:{surfaceValidated:true,surfaceType:'bubble',surfaceKey:'same'}}));
  const result=resolveReadingUnits(rows,placements);
  assert.equal(result.regions.length,2);
  assert.equal(translationEligible(result.regions[0]),false);
});
