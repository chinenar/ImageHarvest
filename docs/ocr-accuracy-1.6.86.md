# OCR 1.6.86

Recover a weak line inside an otherwise high-confidence Latin paragraph by using the detector line bounds for two recognition-only reads (original and contrast). Both reads must agree at confidence >=90, use distinct inference evidence, and match a reading already supported by the independent Tesseract baseline. The change is limited to a small edit distance and at most two attempted lines per paragraph. Segmented and vertical regions are excluded. Preserve the original readings and `lineRecoveryEvidence` for review; do not treat partial-line reads as full-paragraph alternatives.

The development plant page now reads `That's right! I can just combine the poison with Water Edge!`, replacing `ONater Edge!`. The full-page run produced confirming line scores 97.19 and 93.90. No target phrase is hardcoded in production code. Each attempted line costs two extra recognition calls; this is an accuracy correction, not a measured speed improvement.

Plant reference: all 12 best-matching lexical transcriptions are correct, but the strict single-match score remains 11/12 because a graphic-label box overlaps the Water Edge reference area. Ten of twelve best matches preserve punctuation (whitespace ignored). The POISON label, handwriting and margin text still have errors. This is development evidence, not whole-page or held-out accuracy certification.

Reproduce with `npm test`, `node scripts/check-new-ocr-page.cjs`, `node scripts/report-ocr-1.6.86.cjs`, `node scripts/check-new-ocr-holdout.cjs`, and `node scripts/benchmark-ocr-accuracy.cjs --phase=after-1.6.86 --full`.

Validation: 192 general tests pass; syntax passes for 115 desktop JavaScript files. The eight-case/six-image regression retains 11/11 lexical and 10/11 punctuation-inclusive single-match reference units. No region in that suite triggered the new recovery. All region texts on the romance development page remain identical to 1.6.85, including CAN GO, -99 and repaired ellipses. The report was rendered and visually inspected. Packaged source verification passes for 133 files.
