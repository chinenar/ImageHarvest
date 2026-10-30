'use strict';
const { iou } = require('./ocr-review.cjs');

const normalized = text => String(text || '').normalize('NFKC').replace(/\s+/gu, '');
const validBox = b => b && ['x0', 'y0', 'x1', 'y1'].every(k => Number.isFinite(b[k])) &&
  b.x1 > b.x0 && b.y1 > b.y0;
const cross = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) -
  (b[1] - a[1]) * (p[0] - a[0]);
const signedArea = points => points.reduce((sum, p, i) => {
  const next = points[(i + 1) % points.length];
  return sum + p[0] * next[1] - next[0] * p[1];
}, 0) / 2;
function validPolygon(points) {
  if (!Array.isArray(points) || points.length < 3 || points.length > 8 ||
      points.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))) return false;
  const direction = Math.sign(signedArea(points));
  return direction !== 0 && points.every((p, i) => direction *
    cross(p, points[(i + 1) % points.length], points[(i + 2) % points.length]) >= -1e-8);
}
function polygonIou(first, second) {
  let points = first;
  const direction = Math.sign(signedArea(second));
  for (let i = 0; i < second.length && points.length; i++) {
    const a = second[i], b = second[(i + 1) % second.length], clipped = [];
    for (let j = 0; j < points.length; j++) {
      const start = points[j], end = points[(j + 1) % points.length];
      const startSide = direction * cross(a, b, start), endSide = direction * cross(a, b, end);
      if (startSide >= -1e-8) clipped.push(start);
      if ((startSide >= -1e-8) !== (endSide >= -1e-8)) {
        const fraction = startSide / (startSide - endSide);
        clipped.push([start[0] + (end[0] - start[0]) * fraction,
          start[1] + (end[1] - start[1]) * fraction]);
      }
    }
    points = clipped;
  }
  const overlap = Math.abs(signedArea(points));
  return overlap / Math.max(1e-8, Math.abs(signedArea(first)) + Math.abs(signedArea(second)) - overlap);
}
function geometryAgreement(a, b) {
  if (a.polygon && !validPolygon(a.polygon) || b.polygon && !validPolygon(b.polygon)) return false;
  if (a.polygon && b.polygon) return polygonIou(a.polygon, b.polygon) >= .65;
  return validBox(a.bbox) && validBox(b.bbox) && iou(a.bbox, b.bbox) >= .65;
}

// Recover only independently repeated, positioned source lines. Crop-level
// agreement never establishes that the remaining sign or caption was read.
function recoverJapaneseLines(probes = []) {
  const seen = new Set(), observations = [];
  for (const probe of probes) {
    if (probe.error || probe.engine !== 'paddleocr' ||
        typeof probe.inferenceFingerprint !== 'string' || !probe.inferenceFingerprint) continue;
    const identity = probe.engine + ':' + probe.inferenceFingerprint;
    if (seen.has(identity)) continue;
    seen.add(identity);
    // Composed vertical columns may include a low-confidence neighboring
    // fragment. Verify the retained detector lines before composed textLines.
    for (const line of probe.lines?.length ? probe.lines : probe.textLines || []) {
      const text = normalized(line.text), length = Array.from(text).length;
      if (length < 2 || !/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(text) ||
          !Number.isFinite(line.confidence) || line.confidence < (length === 2 ? 90 : 85) ||
          !validBox(line.bbox)) continue;
      observations.push({ line, text, identity, probe });
    }
  }
  observations.sort((a, b) => b.line.confidence - a.line.confidence);
  const recovered = [];
  for (const observation of observations) {
    const support = observations.find(other => other.identity !== observation.identity &&
      other.text === observation.text && Math.max(other.line.confidence, observation.line.confidence) >= 90 &&
      geometryAgreement(other.line, observation.line));
    if (!support || recovered.some(other => normalized(other.text) === observation.text &&
        geometryAgreement(other, observation.line))) continue;
    recovered.push({ ...observation.line, recoveryEvidence: [observation, support].map(row => ({
      engine: row.probe.engine, inferenceFingerprint: row.probe.inferenceFingerprint,
      variant: row.probe.variant, text: row.line.text, confidence: row.line.confidence,
      bbox: row.line.bbox, ...(row.line.polygon ? { polygon: row.line.polygon } : {}),
    })) });
  }
  return recovered;
}
module.exports = { recoverJapaneseLines };
