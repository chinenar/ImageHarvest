# OCR 1.6.85

Recover an omitted word space only when two distinct high-confidence positioned OCR observations agree on the spaced form with identical letters. Original-image components must support one component per letter and a larger inter-word gap at exactly that character boundary under two thresholds. No dictionary, generated word, or extra model request is used.

The conservative check handles unpunctuated ASCII words of 4–16 letters; connected glyphs, accented scripts, vertical text, different spelling, ordinary letter spacing, a single observation and duplicate inference fingerprints are left unchanged. Original alternatives and source gap positions are retained in spacingEvidence.

Target sentence now reads `IT DOESN'T SEEM LIKE IT CAN GO ANY LOWER...`, including spaces and punctuation after normalizing line breaks. This is one development case, not whole-page or unseen-corpus certification.

Reproduce with `npm test`, `node scripts/check-new-ocr-holdout.cjs`, `node scripts/report-ocr-1.6.85.cjs`, and `node scripts/benchmark-ocr-accuracy.cjs --phase=after-1.6.85 --full`.

Validation: 191 general tests pass. The existing eight-case/six-image regression retains 11/11 lexical and 10/11 punctuation-inclusive reference units. No additional region in that suite triggered spacing correction. Target before/after report was rendered and visually inspected.
