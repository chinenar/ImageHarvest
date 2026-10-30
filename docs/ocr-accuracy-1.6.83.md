# OCR 1.6.83

Signed short numeric ambiguity is verified using the multilingual Paddle recognition model only when English results already contain a plausible numeric alternative. Two distinct original/contrast observations must agree exactly, score at least 95, and occupy the same source position. Confusion-shape mapping is used only to identify disagreement; it never generates a replacement reading.

Verified numeric evidence can resolve an overlapping supplemental/CTD duplicate with a conflicting reading. Cross-orientation merging requires both positioned recognition lines to be horizontal. Neighboring regions and manually reviewed/overridden text are preserved. Original readings are stored as duplicate observations.

Romance page development case: handwritten `-99` was two `-qq` regions; it is now one `-99`. Three previous dialogue units remain correct, giving 4/4 targeted units including punctuation. Remaining page punctuation and effects are not claimed fixed. Probe cost is two additional reads on conflicting candidates, not every number.

Validation: `npm test`; `node scripts/check-new-ocr-holdout.cjs`; `node scripts/report-ocr-1.6.83.cjs`; `node scripts/benchmark-ocr-accuracy.cjs --phase=after-1.6.83 --full`. Raw result and report are under `test-results/ocr-accuracy`.

Results: 188 general tests pass. Existing eight-case/six-image benchmark retains 11/11 lexical and 9/11 punctuation-inclusive units, matching the preceding run. Visual before/after report was rendered and inspected. This does not certify numerical recognition on an unseen corpus.
