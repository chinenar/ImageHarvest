# OCR cleanup 1.6.90

Connected foreground components with no support in measured OCR lines are now excluded from cleanup, even if the broad paragraph rectangle includes them. Measured line polygons are used when present, with a one-pixel tolerance. Partially clipped glyphs are retained; this is not a classifier that can distinguish artwork wholly inside a text line.

Already-blocked shared-ink diagnostics additionally reject components with less than 65% support. This stricter mask is never promoted to automatic cleanup by this change. The diagnostic retains the original shared-ink review gate. POISON / Water Edge remains unresolved, and artwork inside the bottle is still present in its proposed mask. LaMa is not added.

Compared with 1.6.89, diagnostic masks exclude another 786 pixels from the paragraph and 911 from POISON. These are mask differences, not independently labeled accuracy improvements. All 20 plant-page paint eligibility states remain unchanged; saved OCR results are reused without changing recognized text.

Validation: 208 tests passed, including 16 reader-quality tests with real Python/OpenCV cleanup checks. New pixel checks preserve artwork between lines while erasing glyphs, and retain partially clipped glyphs. OCR Lab UI regression and syntax checks for 119 JavaScript files passed. The comparison report was visually inspected at `test-results/ocr-accuracy/revision-1.6.90.html`. The packaged ASAR matches all 137 checked source files.
