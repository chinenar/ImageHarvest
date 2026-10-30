# OCR 1.6.82

Fixes on romance sibling page `case-04/0003.webp`:

- `MASTER!` is separated from `IS -99 THE LIMIT?`. A shared detector row is split only with at least two aligned companion rows, a large overhang, and a strong light-to-dark background boundary verified from pixels. Three-line proposals now enter the existing surface check. This conservative new rule currently handles a left light-background fragment alongside a right dark-background paragraph.
- Oblique masks may not erase independently supported high-confidence lines of a neighboring multiline paragraph. `THAT'S PRACTICALLY MURDEROUS INTENT!` is now complete.
- Supplemental partial readings entirely owned by a high-confidence complete line are retained in rejected observations, not sent twice for translation. `ALLY ALLY` is identified as a duplicated fragment of `PRACTICALLY`; manually reviewed regions are preserved.

Three targeted development reference units: 0/3 before, 3/3 after, including punctuation. This is not whole-page accuracy. Remaining page errors include duplicated/misread `-99`, punctuation in `LOWER...` and `...OPPORTUNITY?`, and effects.

Validation: 186 general tests pass; source-background positive/negative Python checks pass. Existing eight cases retain 11/11 lexical units; punctuation is 9/11 in this run. The connected-balloon ellipsis varied from an older report: a fresh run using source extracted from installed 1.6.81 also produces two dots, with identical original/contrast/invert crop fingerprints. This is a reproducible preexisting recognition instability, not evidence that punctuation is solved. Plant page retains 11/12 lexical and 9/12 punctuation-inclusive units.

Validation commands: `npm test`, runtime Python `test/ocr-staggered.py`, `node scripts/check-new-ocr-holdout.cjs`, `node scripts/report-ocr-1.6.82.cjs`, `node scripts/benchmark-ocr-accuracy.cjs --phase=after-1.6.82 --full`. Source observations and manual overrides remain intact. Three-line surface checks are limited to proposals with a row more than twice as wide as its companions.
