# OCR 1.6.84

Ellipsis verification uses original-image connected components at two thresholds. Three small baseline-aligned dots with regular spacing must agree between thresholds, and an existing sufficiently confident same-position OCR alternative must contain the proposed text. Lexical content must match; no new wording is generated. A leading slash can be removed only with a preceding crop-spanning border. Original alternatives and source dot positions are retained in punctuationEvidence.

The local check is limited to conflicting English/French readings. It adds bounded pixel analysis, not another model call. True vertical lines, absent alternate readings, displaced alternates, two/four dots, changed lexical content and a slash without border evidence are negative controls.

Romance development page: LOWER → LOWER...; /...OPPORTUNITY? → ...OPPORTUNITY?. Six reference units improve from 4/6 to 6/6 including punctuation but ignoring spaces. CAN GO remains CANGO; effects and tiny handwriting remain unresolved. Existing DIMENSION ellipsis is also covered by source evidence, subject to the full regression result.

Reproduce with `npm test`, `node scripts/check-new-ocr-holdout.cjs`, `node scripts/report-ocr-1.6.84.cjs`, and `node scripts/benchmark-ocr-accuracy.cjs --phase=after-1.6.84 --full`.

Validation completed: 190 general tests pass; eight-case/six-image regression retains 11/11 lexical units and improves punctuation-inclusive exact units from 9/11 to 10/11. The short-heading ellipsis remains unresolved. Report was rendered and visually inspected; image dots are marked at their original source coordinates.
