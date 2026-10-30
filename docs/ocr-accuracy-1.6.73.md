# OCR accuracy repair, 1.6.73

The 1.6.72 packaged application is the comparison baseline. This change repairs source geometry before recognition: independent line detections can restore a missing heading or unite fragments within the same detector container, but cannot join different containers. Expansion is constrained by neighboring text cores and glyph thickness so ordinary detector padding does not change valid Japanese crops.

Vertical tile observations now share column ownership. Contained duplicate readings retain their original observations for review. Horizontal line grouping rejects strongly different sizes and angles; this separates the small `-99` status from the large adjacent effect in the reference image. Unconfirmed short readings on artwork move into rejected review regions. A narrow source-pixel check restores a standalone exclamation mark only when both its stem and dot are present.

## Evidence and reproducibility

- `node scripts/benchmark-ocr-accuracy.cjs --phase=after --full` runs the actual OCR pipeline against native full source images, then scores manually marked reference areas. It does not feed reference boxes to detection.
- `node scripts/report-ocr-accuracy.cjs` recomputes comparisons from saved reads and produces `test-results/ocr-accuracy/report.html` and `summary.json`.
- Development reference: 8 cases, 11 text units, including English, Japanese connected dialogue, status text, punctuation, and negative artwork areas. Unique lexical matches improved **6/11 → 11/11**; exact transcription including punctuation improved **6/11 → 9/11**. Two ellipses still lose a dot.
- Three false readings in the cat artwork disappear. The cat appears in two reference cases; these are the same three detections, not six independent successes.
- Regression pages: English 8/8 matched with zero matched-character edits; Japanese 11/11 matched with one character edit, unchanged from baseline; synthetic Thai 3/3 with zero edits. Partial references cannot establish whole-page precision.
- The Chinese vertical diagnostic page falls from 18 returned regions to 5. This measures duplicate reduction, not Chinese transcription accuracy; no complete transcription reference exists for that page.
- Checks inspected during development are regression checks, not an untouched test set. These results do not establish whole-corpus accuracy across the 589 images or speed superiority over another application.

## Remaining failures

The plant manga page still mixes adjacent upright and slanted dialogue. Dense multilingual status tables, stylized effects, and some Chinese character readings remain unreliable. A box enclosing a balloon is not sufficient to identify its speaker or isolate its glyphs. The next change needs polygon/mask-based text ownership and per-region language selection, tested against explicit source annotations, rather than broader rectangle expansion or additional blind recognition retries.

Low-confidence short real words can enter review alongside artwork; their original observations are retained. Duplicate-column arbitration also requires review because two recognizers can disagree about the same source glyphs. Neither path should be presented as flawless automatic OCR.
