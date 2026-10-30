# OCR 1.6.79

Two geometry fixes, applied before enhanced recognition:

- Exclude independently supported neighboring text polygons from a crop while preserving the region's own complete line extents. Require multiple high-confidence horizontal lines; uncertain and vertical geometry is unchanged.
- Rejoin aligned fragments from the same detector parent only after source-image layout confirms a shared bubble surface. Reject distinct surfaces, split hints, distant fragments and side-by-side groups. Preserve original fragments for inspection.

## Evidence

New plant page: `8/.../0003.png`, 12 manually transcribed dialogue/caption units. This is now a development case. Correct single-region lexical transcriptions improve from 8/12 to 11/12; punctuation-inclusive transcriptions improve from 6/12 to 9/12. Upper neighboring paragraphs no longer import each other's lettering. The lower `Oh... I made a mistake :(` is recovered as one region rather than three.

Unfixed: `Water Edge!` is still `ONater Edge!`; two sentence-ending punctuation errors remain. SFX, graphic labels and tiny margin comments are excluded from the 12-unit score.

Separate new romance page: `2/.../0003.webp`. Before uses a source snapshot from installed 1.6.78; after uses this revision. All 14 text/bbox outputs are unchanged. This is a non-regression observation, **not** an accuracy pass: `MASTER!` is still merged with the neighboring question, and another paragraph is clipped/split. Those failures require further detector grouping work.

Existing eight-case benchmark (six unique full images): all 11 lexical reference units still pass, 10/11 including punctuation. This small set does not certify the entire corpus.

Validation: 182 general tests and 87 OCR tests passed. The final detector-order preservation adjustment was rechecked with all 21 ownership tests, the affected connected-bubble page, and the new plant page. Syntax validation covers 108 JavaScript files. Unaffected boxes retain their original detector order to avoid changing recognition batching unnecessarily.

## Reproduction

- `node scripts/check-new-ocr-page.cjs`
- `node scripts/check-new-ocr-holdout.cjs`
- `node scripts/report-ocr-1.6.79.cjs`
- `node scripts/benchmark-ocr-accuracy.cjs --phase=after-1.6.79 --full`
- `npm test`
- `npm run test:ocr`

Reports and raw outputs are in `test-results/ocr-accuracy`. The new-page scripts require the user's local corpus and baseline files. No whole-page latency comparison with the other app has been established; the candidate-only layout pass adds work. LaMa integration remains deferred until OCR geometry is reliable.
