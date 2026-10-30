# OCR cleanup 1.6.89

Cleanup now protects source ink belonging to neighboring readings, even when the neighbor is excluded from automatic translation. A connected foreground component that touches a neighboring source zone is preserved as a whole rather than divided by a midpoint. Excluded effect-line proposals are carried into placement as protected geometry. Protection runs after all mask expansion and threshold branches, so neither dilation nor the flat-surface fallback can reintroduce protected pixels.

If protected ink also occupies the current source line, layout records `shared-ink-needs-review` and disables painting. OCR confirmation alone cannot certify ownership of these pixels. The source image is unchanged; diagnostic patches remain available for inspection. This does not automatically separate connected N/W strokes or identify every drawing inside an OCR box. POISON/Water Edge remains unresolved and is blocked from automatic cleanup. The diagnostic mask still includes artwork inside the proposal, so it is not presented as a successful clean.

On the plant page, the proposed mask for the paragraph drops from 17754 to 14109 pixels, protecting 3645 pixels; POISON drops from 4925 to 2474, protecting 2451. These counts are removed candidate-mask pixels, not independently labeled error counts. Both placements are blocked because ownership remains ambiguous.

Tests cover neighboring text within cleanup padding, a connected stroke shared by two readings, ordinary captions, dark buttons, overlay exclusion despite reviewed OCR, and the Lab warning. OCR recognition code and text outputs are unchanged in this revision.

Validation: 206 unit tests passed, 14 reader-quality tests passed against the real Python/OpenCV backend, and the OCR Lab UI regression passed. Packaged and installed v1.6.89 both matched all 137 checked source files. The silent installer exited with code 0 and the installed application launched successfully. Visual diagnostics are in `test-results/ocr-accuracy/revision-1.6.89.html`.
