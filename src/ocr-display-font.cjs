'use strict';
const { intersection, area } = require('./ocr-review.cjs');
const { distinctReadings } = require('./ocr-evidence.cjs');
const compact = (s) => String(s || '').replace(/\s/g, '');
function positionedDisplayReading(readings) {
  const positioned = distinctReadings(
    readings.filter(
      (r) => !r.error && !r.recognizeOnly && r.confidence >= 95 && r.textLines?.length === 1,
    ),
  );
  return positioned.find(
    (r) =>
      compact(r.text).length >= 3 &&
      positioned.some(
        (other) =>
          other !== r &&
          compact(other.text) === compact(r.text) &&
          intersection(r.textLines[0].bbox, other.textLines[0].bbox) /
            Math.max(1, Math.max(area(r.textLines[0].bbox), area(other.textLines[0].bbox))) >
            0.8,
      ),
  );
}
function refineSingleLineGeometry(row, { width, height, scale = 1 }) {
  if (
    row.reviewed ||
    row.contentOverride ||
    row.segmentation ||
    row.orientation === 'vertical' ||
    row.recognitionLines?.length !== 1 ||
    compact(row.text).length < 3
  )
    return row;
  const line = row.recognitionLines[0];
  if (!(line.confidence >= 95) || area(line.bbox) / Math.max(1, area(row.bbox)) >= 0.55) return row;
  const agreeing = distinctReadings(
    (row.alternatives || []).filter(
      (r) => !r.error && !r.recognizeOnly && r.engine === 'paddleocr',
    ),
  ).flatMap((r) =>
    (r.textLines || []).filter(
      (l) =>
        l.confidence >= 95 &&
        compact(l.text) === compact(row.text) &&
        intersection(l.bbox, line.bbox) / Math.max(1, Math.max(area(l.bbox), area(line.bbox))) >
          0.8,
    ),
  );
  if (agreeing.length < 2) return row;
  const own = (row.lines || []).filter(
    (l) =>
      intersection(l.coreBbox || l.bbox, line.bbox) / Math.max(1, area(line.bbox)) > 0.8 &&
      area(l.bbox) < area(line.bbox) * 1.6,
  );
  if (own.length !== 1) return row;
  const detached = (row.lines || []).filter(
    (l) => l !== own[0] && intersection(l.bbox, line.bbox) / Math.max(1, area(l.bbox)) < 0.35,
  );
  if (!detached.length) return row;
  const boxes = [line.bbox, own[0].bbox],
    pad = 2 * scale;
  const bbox = {
    x0: Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.x0)) - pad)),
    y0: Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.y0)) - pad)),
    x1: Math.min(width, Math.ceil(Math.max(...boxes.map((b) => b.x1)) + pad)),
    y1: Math.min(height, Math.ceil(Math.max(...boxes.map((b) => b.y1)) + pad)),
  };
  return {
    ...row,
    bbox,
    detectorBBox: row.detectorBBox || row.bbox,
    lines: own,
    localizationRefinement: 'confirmed-single-line-with-foreign-proposals',
    excludedLineProposals: detached,
    reviewRequired: true,
  };
}
function clippedPunctuationOwner(row, rows) {
  if (
    !row.discoveryOnly ||
    row.reviewed ||
    row.contentOverride ||
    row.recognitionLines?.length !== 1 ||
    !(row.detectionConfidence < 0.75)
  )
    return null;
  const part = row.recognitionLines[0],
    value = compact(row.text),
    match = /^([A-Za-z]{3,16})([!?.,]+)$/.exec(value);
  if (!match || part.bbox.x1 < (row.detectorBBox || row.bbox).x1 - 2) return null;
  return (
    rows.find((parent) => {
      if (
        parent === row ||
        parent.reviewed ||
        parent.contentOverride ||
        !(parent.detectionConfidence >= 0.85) ||
        parent.recognitionLines?.length !== 1
      )
        return false;
      const line = parent.recognitionLines[0],
        full = compact(parent.text),
        parsed = /^([A-Za-z]{3,16})([!?.,]+)$/.exec(full);
      if (
        !parsed ||
        parsed[1] !== match[1] ||
        !parsed[2].startsWith(match[2]) ||
        parsed[2].length <= match[2].length
      )
        return false;
      if (
        !(line.confidence >= 95) ||
        intersection(part.bbox, line.bbox) / Math.max(1, area(part.bbox)) < 0.95 ||
        line.bbox.x1 - line.bbox.x0 < (part.bbox.x1 - part.bbox.x0) * 1.2
      )
        return false;
      return (
        distinctReadings(
          (parent.alternatives || []).filter(
            (r) => !r.error && r.confidence >= 95 && compact(r.text) === full,
          ),
        ).length >= 2
      );
    }) || null
  );
}
module.exports = { positionedDisplayReading, refineSingleLineGeometry, clippedPunctuationOwner };
