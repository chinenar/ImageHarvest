'use strict';
const { editDistance, intersection, area } = require('./ocr-review.cjs');
const { distinctReadings } = require('./ocr-evidence.cjs');
const compact = (s) =>
  String(s || '')
    .normalize('NFKC')
    .replace(/\s/g, '');
function agree(probes, minimum = 90) {
  return (
    probes.length === 2 &&
    probes.every(
      (r) => !r.error && r.inferenceFingerprint && r.confidence >= minimum && compact(r.text),
    ) &&
    distinctReadings(probes).length === 2 &&
    compact(probes[0].text) === compact(probes[1].text)
  );
}
function unrotatePoint(x, y, width, height, rotation) {
  return rotation === 90 ? [y, height - x] : rotation === 270 ? [width - y, x] : [x, y];
}
async function recoverRotated(chosen, candidate, read) {
  const b = candidate.bbox;
  if (
    candidate.orientation !== 'vertical' ||
    candidate.detectedLanguage === 'ja' ||
    !(chosen.confidence < 80) ||
    (b.y1 - b.y0) / (b.x1 - b.x0) < 4
  )
    return chosen;
  for (const rotation of [90, 270]) {
    const probes = await Promise.all(
      ['original', 'contrast'].map((variant) =>
        read(variant, { rotation, box: b, pad: 2, scale: 3, recognizeOnly: true }),
      ),
    );
    if (
      !agree(probes, 95) ||
      !/^[\x20-\x7e\s]+$/.test(probes[0].text) ||
      (probes[0].text.match(/[A-Za-z]/g) || []).length < 8
    )
      continue;
    return {
      ...probes[0],
      orientation: 'vertical',
      textRotation: rotation,
      selectionReason: 'rotated-latin-agreement',
      rotationEvidence: { rotation, previous: chosen, probes },
    };
  }
  return chosen;
}
async function recoverDetail(chosen, readings, candidate, read, { width, height, scale = 1 }) {
  if (candidate.segmentation || candidate.orientation === 'vertical' || !chosen.textLines?.length)
    return chosen;
  const text = compact(chosen.text),
    lines = chosen.textLines;
  const close = (other) => {
    const d = editDistance(compact(other), text);
    return d > 0 && d / Math.max(text.length, compact(other).length) <= 0.2;
  };
  const shortConflict =
    lines.length === 1 &&
    /^[A-Za-z]{4,16}$/.test(text) &&
    readings.some((r) => r.confidence >= 90 && close(r.text));
  const heights = (candidate.lines || [])
    .map((l) => {
      const b = l.coreBbox || l.bbox;
      return b.y1 - b.y0;
    })
    .sort((a, b) => a - b);
  const tiny =
    heights.length &&
    heights[Math.floor(heights.length / 2)] <= 12 * scale &&
    text.length >= 6 &&
    lines.length <= 3;
  if (!shortConflict && !tiny) return chosen;
  const bounds = [candidate.bbox, ...lines.map((l) => l.bbox)],
    box = {
      x0: Math.max(0, Math.floor(Math.min(...bounds.map((b) => b.x0)) - 3 * scale)),
      y0: Math.max(0, Math.floor(Math.min(...bounds.map((b) => b.y0)) - 4 * scale)),
      x1: Math.min(width, Math.ceil(Math.max(...bounds.map((b) => b.x1)) + 2 * scale)),
      y1: Math.min(height, Math.ceil(Math.max(...bounds.map((b) => b.y1)) + 3 * scale)),
    };
  const probes = await Promise.all(
    ['original', 'contrast'].map((variant) =>
      read(variant, { box, pad: 0, scale: 4, lang: shortConflict ? 'zh' : 'en' }),
    ),
  );
  if (!agree(probes) || !close(probes[0].text)) return chosen;
  const proposal = probes[0],
    key = compact(proposal.text);
  // Enlarging a crop must not adopt unrelated nearby lettering or change layout.
  if (
    proposal.textLines?.length !== lines.length ||
    proposal.textLines.some(
      (l, i) =>
        !l.bbox ||
        intersection(l.bbox, lines[i].bbox) /
          Math.max(1, Math.min(area(l.bbox), area(lines[i].bbox))) <
          0.6,
    )
  )
    return chosen;
  let support = readings.find((r) => r.confidence >= 90 && compact(r.text) === key);
  if (!support && !shortConflict) {
    support = await read('original', { box, pad: 0, scale: 4, lang: 'zh' });
    if (!(support.confidence >= 95) || compact(support.text) !== key) return chosen;
  }
  if (!support) return chosen;
  return {
    ...proposal,
    selectionReason: 'detail-crop-cross-model-agreement',
    detailEvidence: { previous: chosen, box, probes, support },
  };
}
function sparseScriptConflict(row, probes) {
  if (
    row.reviewed ||
    row.contentOverride ||
    row.sparseReadingReview !== JSON.stringify([row.text, row.bbox]) ||
    probes.length !== 2 ||
    probes.some((r) => r.error || !r.inferenceFingerprint) ||
    distinctReadings(probes).length !== 2
  )
    return row;
  const text = compact(probes[0].text);
  if (
    !/^[\p{Script=Hiragana}\p{Script=Katakana}]{1,2}$/u.test(text) ||
    compact(probes[1].text) !== text ||
    text === compact(row.text)
  )
    return row;
  // A generative model can hallucinate on drawings. Expose the competing
  // script for human review, never promote it from self-agreement alone.
  return {
    ...row,
    scriptConflictEvidence: { signature: JSON.stringify([row.text, row.bbox]), text, probes },
    alternatives: [...row.alternatives, ...probes],
    reviewRequired: true,
  };
}
module.exports = { agree, unrotatePoint, recoverRotated, recoverDetail, sparseScriptConflict };
