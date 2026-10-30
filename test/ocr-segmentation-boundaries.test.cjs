'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveReadingUnits } = require('../src/reading-units.cjs');

const line = (text, bbox) => ({ text, bbox, confidence: 99 });
const onConnectedSurface = (rows) => rows.map((row) => ({
  id: row.id,
  placement: { surfaceType: 'bubble', surfaceValidated: true, surfaceKey: 'connected-white-surface' },
}));

test('distinct detected balloon parts remain two readings on one connected white surface', () => {
  // Native positioned observations from live/0004-result.json; no inference or image fixture needed.
  const rows = [
    {
      id: 'upper', text: "It's time!!\nTime to try\nwhat I've\nhoned over\nthe past few\ndays!!",
      bbox: { x0: 678, y0: 372, x1: 922, y1: 608 },
      orientation: 'horizontal', containerId: 'block-1', segmentation: 'balloon-boundaries', part: 0,
      recognitionLines: [
        line("It's time!!", { x0: 767, y0: 362.5, x1: 932, y1: 401 }),
        line('Time to try', { x0: 678, y0: 414.5, x1: 864.5, y1: 458 }),
        line("what I've", { x0: 691, y0: 456, x1: 851.5, y1: 493 }),
        line('honed over', { x0: 681.5, y0: 495.5, x1: 860.5, y1: 533.5 }),
        line('the past few', { x0: 667, y0: 535, x1: 886, y1: 580 }),
        line('days!!', { x0: 723, y0: 573.5, x1: 821, y1: 618.5 }),
      ],
    },
    {
      id: 'lower', text: "Well... Let's\ngo!!!,",
      bbox: { x0: 591, y0: 620, x1: 770, y1: 684 },
      orientation: 'horizontal', containerId: 'block-1', segmentation: 'balloon-boundaries', part: 1,
      recognitionLines: [
        line("Well... Let's", { x0: 581, y0: 610, x1: 775.5, y1: 647.5 }),
        line('go!!!,', { x0: 639.5, y0: 649, x1: 727, y1: 696 }),
      ],
    },
  ];
  const saved = structuredClone(rows);
  const resolved = resolveReadingUnits(rows, onConnectedSurface(rows));
  assert.equal(resolved.regions.length, 2);
  assert.deepEqual(resolved.regions.map((row) => row.text), rows.map((row) => row.text));
  assert.deepEqual(resolved.changes, []);
  assert.deepEqual(rows, saved);
});

test('shared positioned duplicate observations can deduplicate across detected parts', () => {
  const rows = [
    { id: 'complete', text: 'Hello world', bbox: { x0: 10, y0: 10, x1: 110, y1: 40 },
      containerId: 'block-1', segmentation: 'balloon-boundaries', part: 0,
      recognitionLines: [line('Hello world', { x0: 10, y0: 10, x1: 110, y1: 40 })] },
    { id: 'duplicate', text: 'Hello', bbox: { x0: 10, y0: 10, x1: 60, y1: 40 },
      containerId: 'block-1', segmentation: 'balloon-boundaries', part: 1,
      recognitionLines: [line('Hello', { x0: 10, y0: 10, x1: 60, y1: 40 })] },
  ];
  const resolved = resolveReadingUnits(rows, onConnectedSurface(rows));
  assert.equal(resolved.regions.length, 1);
  assert.equal(resolved.regions[0].text, 'Hello world');
  assert.equal(resolved.regions[0].unitSuppressedLines.length, 1);
});

test('complementary fragments within one detected part still compose one reading', () => {
  const rows = [
    { id: 'left', text: 'Hello', bbox: { x0: 10, y0: 10, x1: 60, y1: 40 },
      containerId: 'block-1', segmentation: 'balloon-boundaries', part: 0,
      recognitionLines: [line('Hello', { x0: 10, y0: 10, x1: 60, y1: 40 })] },
    { id: 'right', text: 'world', bbox: { x0: 65, y0: 10, x1: 115, y1: 40 },
      containerId: 'block-1', segmentation: 'balloon-boundaries', part: 0,
      recognitionLines: [line('world', { x0: 65, y0: 10, x1: 115, y1: 40 })] },
  ];
  const resolved = resolveReadingUnits(rows, onConnectedSurface(rows));
  assert.equal(resolved.regions.length, 1);
  assert.equal(resolved.regions[0].text, 'Hello world');
});

test('an unsegmented broad observation cannot transitively reunite distinct detected parts', () => {
  const upperLine = line('Upper speech', { x0: 10, y0: 10, x1: 100, y1: 30 });
  const lowerLine = line('Lower speech', { x0: 10, y0: 40, x1: 100, y1: 60 });
  const upper = { id: 'upper', text: upperLine.text, bbox: upperLine.bbox,
    containerId: 'block-1', segmentation: 'balloon-boundaries', part: 0, recognitionLines: [upperLine] };
  const lower = { id: 'lower', text: lowerLine.text, bbox: lowerLine.bbox,
    containerId: 'block-1', segmentation: 'balloon-boundaries', part: 1, recognitionLines: [lowerLine] };
  const bridge = { id: 'bridge', text: 'Upper speech\nLower speech',
    bbox: { x0: 10, y0: 10, x1: 100, y1: 60 }, recognitionLines: [upperLine, lowerLine] };
  // The bridge shares a true positioned observation with each part. Neither
  // pairwise duplicate match establishes that the two parts themselves match.
  for (const rows of [[upper, lower, bridge], [bridge, lower, upper], [lower, bridge, upper]]) {
    const result = resolveReadingUnits(rows, onConnectedSurface(rows));
    assert.equal(result.regions.length, 2);
    assert.ok(result.regions.every((row) => !(row.sourceRegionIds || []).includes('upper') || !(row.sourceRegionIds || []).includes('lower')));
  }
});

test('a third duplicate can still deduplicate when conflicting parts share positioned evidence', () => {
  const observation = line('One speech', { x0: 10, y0: 10, x1: 100, y1: 30 });
  const rows = [0, 1, 2].map((part) => ({
    id: 'duplicate-' + part, text: observation.text, bbox: observation.bbox,
    ...(part < 2 ? { containerId: 'block-1', segmentation: 'balloon-boundaries', part } : {}),
    recognitionLines: [observation],
  }));
  const result = resolveReadingUnits(rows, onConnectedSurface(rows));
  assert.equal(result.regions.length, 1);
  assert.equal(result.regions[0].text, 'One speech');
  assert.equal(result.regions[0].unitSuppressedLines.length, 2);
});
