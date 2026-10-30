'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  sharp = require('sharp');
const {
  agree,
  unrotatePoint,
  recoverRotated,
  recoverDetail,
  sparseScriptConflict,
} = require('../src/ocr-targeted-recovery.cjs');
const { terminalDot, repairTerminalPeriod } = require('../src/ocr-terminal-period.cjs');
const { markOverlappingReadings } = require('../src/ocr-overlap-review.cjs');
const { translationEligible } = require('../src/ocr-content-role.cjs');
const { prepareCrop, validateCrop } = require('../src/ocr-crop.cjs');
const { repairEllipsis } = require('../src/ocr-ellipsis.cjs');
const {
  positionedDisplayReading,
  refineSingleLineGeometry,
  clippedPunctuationOwner,
} = require('../src/ocr-display-font.cjs');
const { reconcileDiscovery } = require('../src/ocr-discovery.cjs');
const b = (x0, y0, x1, y1) => ({ x0, y0, x1, y1 });
const read = (text, bbox, key, confidence = 98) => ({
  text,
  confidence,
  inferenceFingerprint: key,
  engine: 'paddleocr',
  textLines: [{ text, bbox, confidence }],
});

test('display-font discovery does not join an overlapping action effect into its crop', () => {
  const display = {
    bbox: b(40, 100, 650, 440),
    coreBbox: b(40, 100, 650, 440),
    displayFont: true,
    orientation: 'horizontal',
    detectionConfidence: 0.5,
  };
  const effect = {
    bbox: b(390, 320, 690, 680),
    coreBbox: b(390, 320, 690, 680),
    orientation: 'horizontal',
    detectionConfidence: 0.85,
  };
  const result = reconcileDiscovery({ boxes: [] }, [display, effect]);
  assert.equal(result.boxes.length, 2);
  assert.deepEqual(result.boxes.find((r) => r.displayFont).bbox, display.bbox);
});

test('clipped punctuation duplicate needs a complete positioned parent and preserves manual readings', () => {
  const part = b(140, 20, 430, 170),
    whole = b(120, 15, 565, 180);
  const child = {
    text: 'DIE!',
    bbox: b(0, 0, 430, 500),
    detectorBBox: b(0, 0, 417, 500),
    discoveryOnly: true,
    detectionConfidence: 0.65,
    recognitionLines: [{ text: 'DIE!', bbox: part, confidence: 99 }],
  };
  const parent = {
    text: 'DIE!!',
    bbox: whole,
    detectionConfidence: 0.92,
    recognitionLines: [{ text: 'DIE!!', bbox: whole, confidence: 99 }],
    alternatives: ['a', 'b'].map((k) => read('DIE!!', whole, k, 99)),
  };
  assert.equal(clippedPunctuationOwner(child, [child, parent]), parent);
  assert.equal(clippedPunctuationOwner({ ...child, reviewed: true }, [parent]), null);
  assert.equal(
    clippedPunctuationOwner(child, [{ ...parent, alternatives: [parent.alternatives[0]] }]),
    null,
  );
  assert.equal(
    clippedPunctuationOwner({ ...child, detectorBBox: b(0, 0, 800, 500) }, [parent]),
    null,
  );
  assert.equal(clippedPunctuationOwner({ ...child, text: 'DIE?' }, [parent]), null);
});

test('positioned display-font agreement outranks whole-crop truncation and rejects duplicate votes', () => {
  const bbox = b(10, 10, 300, 100),
    positioned = ['a', 'b'].map((k) => read('MEEEEEEEEEH!!!', bbox, k, 97));
  const whole = ['c', 'd'].map((k) => ({
    ...read('MEEEEEEEH!', bbox, k, 88),
    recognizeOnly: true,
  }));
  assert.equal(positionedDisplayReading([...whole, ...positioned]).text, 'MEEEEEEEEEH!!!');
  assert.equal(positionedDisplayReading([positioned[0], positioned[0], ...whole]), undefined);
  assert.equal(
    positionedDisplayReading([
      positioned[0],
      { ...positioned[1], textLines: [{ text: 'MEEEEEEEEEH!!!', bbox: b(400, 200, 600, 300) }] },
    ]),
    undefined,
  );
});

test('confirmed single-line bounds leave a foreign effect proposal outside the dialogue box', () => {
  const bbox = b(0, 0, 400, 400),
    own = b(100, 20, 380, 150),
    effect = b(0, 150, 180, 390),
    l = { text: 'DIE!!', bbox: b(110, 25, 370, 145), confidence: 99 };
  const row = {
    text: 'DIE!!',
    bbox,
    recognitionLines: [l],
    lines: [{ bbox: own }, { bbox: effect }],
    alternatives: ['a', 'b'].map((k) => read('DIE!!', l.bbox, k, 99)),
  };
  const fixed = refineSingleLineGeometry(row, { width: 500, height: 500 });
  assert.deepEqual(fixed.bbox, b(98, 18, 382, 152));
  assert.deepEqual(fixed.excludedLineProposals, [row.lines[1]]);
  assert.deepEqual(fixed.detectorBBox, bbox);
  assert.equal(
    refineSingleLineGeometry({ ...row, reviewed: true }, { width: 500, height: 500 }).bbox,
    bbox,
  );
  assert.equal(
    refineSingleLineGeometry(
      { ...row, alternatives: [row.alternatives[0]] },
      { width: 500, height: 500 },
    ).bbox,
    bbox,
  );
});

test('rotated Latin recovery requires distinct confident readings and maps coordinates back', async () => {
  const bbox = b(10, 20, 30, 400),
    chosen = { text: 'gibberish', confidence: 45 },
    candidate = { bbox, orientation: 'vertical', detectedLanguage: 'latin' };
  const result = await recoverRotated(chosen, candidate, (v, o) =>
    Promise.resolve(read('Rotated margin text?', bbox, v)),
  );
  assert.equal(result.text, 'Rotated margin text?');
  assert.equal(result.textRotation, 90);
  assert.equal(
    await recoverRotated(chosen, { ...candidate, detectedLanguage: 'ja' }, () => {
      throw Error('must not probe Japanese columns');
    }),
    chosen,
  );
  assert.equal(
    await recoverRotated(chosen, candidate, () =>
      Promise.resolve(read('Rotated margin text?', bbox, 'same')),
    ),
    chosen,
  );
  assert.deepEqual(unrotatePoint(60, 15, 50, 100, 90), [15, 40]);
  assert.deepEqual(unrotatePoint(40, 35, 50, 100, 270), [15, 40]);
  assert.equal(agree([read('A', bbox, undefined), read('A', bbox, undefined)]), false);
});

test('crop preview reproduces rotation and rejects unsupported angles', async () => {
  const input = await sharp({ create: { width: 20, height: 80, channels: 3, background: '#fff' } })
    .png()
    .toBuffer();
  const crop = {
    rectangle: { left: 0, top: 0, width: 20, height: 80 },
    width: 40,
    border: 12,
    inputScale: 1,
    rotation: 90,
  };
  validateCrop(crop, 20, 80);
  const meta = await sharp(await prepareCrop(input, crop, { prepared: true })).metadata();
  assert.equal(meta.width, 184);
  assert.equal(meta.height, 64);
  assert.throws(() => validateCrop({ ...crop, rotation: 45 }, 20, 80));
});

test('short label recovery requires existing support and rejects foreign geometry or extra text', async () => {
  const bbox = b(10, 10, 110, 40),
    chosen = read('LABELM', bbox, 'old'),
    support = read('LABELN', bbox, 'support', 95),
    candidate = { bbox, lines: [{ bbox }] };
  const options = { width: 200, height: 100 };
  const fixed = await recoverDetail(
    chosen,
    [support],
    candidate,
    (v) => Promise.resolve(read('LABELN', bbox, v)),
    options,
  );
  assert.equal(fixed.text, 'LABELN');
  assert.ok(fixed.detailEvidence);
  assert.equal(chosen.text, 'LABELM');
  assert.equal(
    await recoverDetail(
      chosen,
      [support],
      candidate,
      (v) => Promise.resolve(read('LABELN', b(120, 60, 180, 80), v)),
      options,
    ),
    chosen,
  );
  assert.equal(
    await recoverDetail(
      chosen,
      [support],
      candidate,
      (v) => Promise.resolve(read('LABELN ADDED', bbox, v)),
      options,
    ),
    chosen,
  );
});

test('small kana disagreement remains reviewable and is never promoted by generative self-agreement', () => {
  const bbox = b(0, 0, 20, 20),
    row = { text: '5', bbox, alternatives: [], sparseReadingReview: JSON.stringify(['5', bbox]) };
  const fixed = sparseScriptConflict(row, [read('ち', bbox, 'a'), read('ち', bbox, 'b')]);
  assert.equal(fixed.text, '5');
  assert.equal(fixed.scriptConflictEvidence.text, 'ち');
  assert.equal(fixed.alternatives.length, 2);
  assert.equal(translationEligible(fixed), false);
  assert.equal(translationEligible({ ...fixed, reviewed: true }), true);
  assert.equal(sparseScriptConflict(row, [read('ち', bbox, 'a'), read('ち', bbox, 'a')]), row);
});

test('overlap review uses actual lines, preserves neighboring paragraphs and manual decisions', () => {
  const make = (text, bbox, lines) => ({
    text,
    bbox,
    recognitionLines: lines.map((bbox) => ({ text, bbox, confidence: 98 })),
  });
  const first = make('First', b(0, 0, 100, 100), [b(0, 0, 40, 20)]),
    second = make('Second', b(20, 0, 120, 100), [b(60, 50, 100, 70)]);
  assert.ok(markOverlappingReadings([first, second]).every((r) => !r.overlapReview));
  const touching = make('Label', b(20, 0, 60, 20), [b(20, 0, 60, 20)]),
    rows = markOverlappingReadings([first, touching]);
  assert.ok(rows.every((r) => r.overlapReview && !translationEligible(r)));
  assert.equal(translationEligible({ ...rows[0], reviewed: true }), true);
  assert.equal(translationEligible({ ...rows[0], bbox: b(0, 0, 10, 10) }), true);
  assert.ok(
    markOverlappingReadings([first, { ...touching, reviewed: true }]).every(
      (r) => !r.overlapReview,
    ),
  );
});

test('terminal dot rejects comma tails and requires OCR support for a missing period', async () => {
  const letters = [10, 25, 40].map((x) => ({ x0: x, y0: 5, x1: x + 8, y1: 25, size: 160 })),
    dot = { x0: 53, y0: 22, x1: 57, y1: 25, size: 12 };
  const scan = {
    left: 0,
    top: 0,
    height: 30,
    h: 36,
    passes: [
      [...letters, dot],
      [...letters, dot],
    ],
  };
  assert.ok(terminalDot(scan));
  assert.equal(
    terminalDot({
      ...scan,
      passes: scan.passes.map((p) => [...p.slice(0, -1), { ...dot, y1: 31 }]),
    }),
    null,
  );
  const image = await sharp(
    Buffer.from(
      '<svg width="100" height="40"><rect width="100" height="40" fill="white"/>' +
        [10, 25, 40].map((x) => `<rect x="${x}" y="5" width="8" height="20"/>`).join('') +
        '<rect x="53" y="22" width="4" height="3"/></svg>',
    ),
  )
    .png()
    .toBuffer();
  const bbox = b(7, 2, 59, 32),
    chosen = read('ABC', bbox, 'old'),
    options = { width: 100, height: 40 };
  const fixed = await repairTerminalPeriod(
    image,
    chosen,
    [],
    (v) => Promise.resolve(read('ABC.', bbox, v)),
    options,
  );
  assert.equal(fixed.text, 'ABC.');
  assert.ok(fixed.punctuationEvidence);
  assert.equal(
    await repairTerminalPeriod(
      image,
      chosen,
      [],
      (v) => Promise.resolve(read('ABC,', bbox, v)),
      options,
    ),
    chosen,
  );
});

test('two-dot OCR can recover the third source dot without inventing an ellipsis', async () => {
  const draw = async (count) =>
    sharp(
      Buffer.from(
        '<svg width="180" height="50"><rect width="180" height="50" fill="white"/>' +
          [10, 30, 50].map((x) => `<rect x="${x}" y="10" width="12" height="25"/>`).join('') +
          Array.from(
            { length: count },
            (_, i) => `<rect x="${70 + i * 9}" y="31" width="4" height="4"/>`,
          ).join('') +
          '</svg>',
      ),
    )
      .png()
      .toBuffer();
  const chosen = read('ABC..', b(7, 5, 96, 40), 'old');
  assert.equal((await repairEllipsis(await draw(3), chosen, [])).text, 'ABC...');
  assert.equal(await repairEllipsis(await draw(2), chosen, []), chosen);
});
