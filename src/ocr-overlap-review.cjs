'use strict';
const { intersection, area } = require('./ocr-review.cjs');
const {rawLines}=require('./reading-units.cjs');
const signature = (row) => JSON.stringify([row.text, row.bbox]);
const compact=text=>String(text||'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
function containedFragment(host,fragment){
 const a=compact(host.text),b=compact(fragment.text);
 return host.confidence>=95&&b.length>=3&&a.length>=b.length*1.5&&a.includes(b)&&intersection(host.bbox,fragment.bbox)/Math.max(1,area(fragment.bbox))>=.9;
}
function markOverlappingReadings(rows) {
  return rows.map((row) => {
    if (row.reviewed || row.contentOverride || row.orientation === 'vertical') return row;
    const lines = rawLines(row).filter((l) => l.confidence >= 85);
    const neighbors = rows.filter(
      (other) =>
        other !== row &&
        !other.reviewed &&
        !other.contentOverride &&
        other.orientation !== 'vertical' &&
        other.text !== row.text &&
        lines.some((l) =>
          rawLines(other).some(
            (k) =>
              k.confidence >= 85 &&
              !containedFragment(l,k) &&
              intersection(l.bbox, k.bbox) / Math.max(1, Math.min(area(l.bbox), area(k.bbox))) >
                0.2,
          ),
        ),
    );
    if (!neighbors.length){const clean={...row};delete clean.overlapReview;return clean;}
    // Rectangle overlap cannot decide which ink belongs to which word. Keep
    // both readings and require review before translation/cleaning can erase it.
    return {
      ...row,
      reviewRequired: true,
      overlapReview: {
        signature: signature(row),
        neighbors: neighbors.map((r) => ({ text: r.text, bbox: r.bbox })),
      },
    };
  });
}
module.exports = { markOverlappingReadings };
