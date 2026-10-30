# OCR 1.6.77

This increment adds selective first-pass acceptance and source-based review of oversized unboxed lettering. It does not finish automatic SFX classification. LaMa and other inpainting models are not added.

## Selective recognition retries

Only attempt the shorter path when an independent Tesseract reading is confident and every detector line is reliable. Accept the original Paddle reading without contrast/invert only when it exactly agrees (including punctuation), scores at least 95, and covers at least 80% of each detected source line. Display fonts, supplemental proposals, explicit review cases, and incomplete readings keep recovery. Explicit all-variants mode also keeps every pass. `retryDecision` records the decision per region. `IMAGEHARVEST_OCR_EAGER_VARIANTS=1` disables the shorter path for comparison.

On eight development cases from six distinct input images, five accepted regions avoided two initial variant reads each. This is ten fewer requested crop reads, not a demonstrated whole-job speedup. Frozen reference results stayed at 11/11 unique lexical matches and 10/11 punctuation matches, with no detections in the annotated negative areas. The three plant-page dialogue units and three table-region results remained unchanged: left and right labels exact, skill list still missing two characters.

## Possible effects, not automatic definitive labels

The placement stage uses at least three source-validated dialogue surfaces to estimate typical glyph size. A short single-line, nonnumeric reading on an unvalidated scene surface with glyph height/width at least three times that reference is marked for review. It remains its original kind and source text. A bubble, explicit user decision, edited text/geometry, insufficient page context, and numeric labels cannot use this evidence to block translation.

Normal translation skips these uncertain candidates. The existing include-uncertain option deliberately includes them, and manual correction remains available. OCR Lab performs source-surface analysis before translation only when a preliminary geometry screen finds a possible candidate, and displays the specific review reason. Automatic webpage translation reuses its existing placement analysis.

A three-page development inspection initially flagged one status-label region incorrectly; numeric readings were excluded before release. After adjustment, the connected-dialogue page has nine candidates when previously rejected reads are also inspected; eight were already rejected. The remaining `OPi` reading is visibly Korean stylized lettering, but it was already withheld by the previous low-confidence gate. This improves review provenance, not measured SFX recall or a new successful translation block. The other two inspected pages have no candidates. This narrow heuristic misses many effects and must not be described as a complete classifier.

Validation artifacts: `test-results/ocr-accuracy/summary-1.6.77.json`, `plant-1.6.77.json`, `effect-candidates.json`, and the source crop `effect-connected-0.png`. General tests passed 180; the Electron review UI check passed. The full OCR suite and package/install checks are recorded in their run logs.
