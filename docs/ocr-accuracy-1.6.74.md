# OCR source ownership, 1.6.74

The adjacent-dialogue example from the user's plant manga page contained three text units, all incorrect in 1.6.73. The complete native page now returns each unit once with correct lexical text:

- `I feel like I've grown a bit.`
- `I've also moved from growing on the stone to in the ground.`
- `Is it the work of the goddess?`

The middle unit still loses its final period, so exact punctuation is 2/3. This is a development reference, not an untouched evaluation or whole-page accuracy claim.

## Change

The segmentation worker identifies a shared row only when several rows on each side establish two distinct, stable alignments and an ink-free source gap exists between them. It preserves the original observations and records the cut edge; an ordinary centered paragraph or connected ink is not split.

Two parallel oblique lines, supported across preprocessing variants, can now retain polygon ownership. OCR crops mask those lines and exclude them from neighboring crops instead of treating overlapping rectangles as shared text. Modest extension along each line recovers terminal glyphs omitted by the detector. Polygon metadata survives scaled OCR and exact crop previews. These are recognition masks; the UI can still display enclosing rectangles.

## Verification

`node scripts/check-ocr-accuracy-holdout.cjs --case=angled-dialogue-page` runs the actual full-page pipeline. `node scripts/report-ocr-staggered.cjs` compares its saved output with `holdout-1.6.73`, checks all three phrases within the source area, and creates a before/after image and HTML report under `test-results/ocr-accuracy/`.

The original development reference remains 11/11 unique lexical matches and 9/11 exact punctuation. Regression checks include real English and Japanese, synthetic Thai, Chinese columns, polygon crop reconstruction at scale 2, no-cut-through-ink controls, and preservation of ordinary paragraph grouping.

Release checks passed: 169 general tests, 74 OCR tests, syntax checks for 101 desktop JavaScript files, and packaged-source verification for 119 files.

## Limits

This does not solve all effect classification, dense multilingual tables, or Chinese transcription errors. Polygons are detector estimates and are marked for review. Speed comparisons with the other app remain unmeasured; cold initialization varied substantially in these local runs. No new model or additional recognition pass was added by the ownership repair.
