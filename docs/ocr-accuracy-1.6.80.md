# OCR 1.6.80

The large box over the plant drawing contains a small handwritten mark which English OCR reads as `5`. Recognition confidence (97) did not validate the much larger detector rectangle (confidence .44). It must not be labeled pure artwork or silently discarded.

`ocr-sparse-geometry.cjs` narrows weak horizontal proposals only when a positioned detector observation and at least two distinct high-confidence OCR observations agree on a short fragment occupying at most 20% of the original rectangle. Original detector geometry and readings remain available. Unconfirmed readings are withheld from automatic translation, with manual review/override and stale-signature invalidation. Vertical text, segmentation, manual corrections, dense text and strong detector proposals are unchanged.

For neighbor-protected dialogue, OCR Lab draws and hit-tests individual recognized line boxes while retaining one dialogue unit. Text/bbox changes invalidate the display geometry. This is visualization of recognized line extents, not a claim that the entire bounding rectangle is text or an exact pixel mask.

Observed plant-page fragment: 217×192 becomes 67×73 pixels. All 12 reference dialogue units retain their previous scores: 11/12 lexical, 9/12 punctuation-inclusive. The handwritten mark itself is **not** recognized correctly yet. Tiny margin text, effects and difficult scripts remain unverified.

Validation: `npm test`, `node test/ocr-effects.e2e.cjs` (includes actual canvas line-box drawing), `node scripts/check-new-ocr-page.cjs`, `node scripts/benchmark-ocr-accuracy.cjs --phase=after-1.6.80 --full`. Results/report: `test-results/ocr-accuracy/revision-1.6.80.html`; raw new-page snapshot: `new-plant-1.6.80.json`.
