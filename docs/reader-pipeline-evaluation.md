# Reader pipeline evaluation

The first offline benchmark covers five text regions in three previously inspected crops: touching POISON / Water Edge, an italic English balloon, and two vertical Japanese paragraphs. It is a development/regression set, not a new holdout or a corpus accuracy claim. No experimental cleaner is installed or enabled in the application.

## Run

`npm run benchmark:reader-pipeline` uses the existing CTD ONNX model, installed OCR Python/OpenCV runtime, and local source images referenced by `test/fixtures/reader-pipeline-observations/*.json`. Source SHA-256 checks reject changed images. Frozen observations preserve the original reading geometry and exclusion state without requiring old files under test-results. Results go to `test-results/reader-pipeline/report.html`; provenance records source/model/code hashes. The report uses fixed Thai layout samples, not a translation service.

`npm run test:reader-font-scale` checks the actual Electron overlay at 60%, 100%, and 150%, manual font sizing, and keeping a Thai word on one line. `test/reader-pipeline-metrics.py`, run with the OCR Python runtime, checks that abstention cannot score as successful cleaning and that damage to non-text ink is counted independently.

## Separate evaluation stages

- OCR: exact matches against manually transcribed text, using cached readings; this does not time or rerun recognition.
- Masks: compare current proposed masks, current permitted masks, raw CTD segmentation, one-pixel expansion, and model-selected connected components. The model's `seg` output was previously unused. Export is opt-in; normal detection does not serialize a probability image.
- Cleanup: every candidate mask is filled with the same OpenCV Telea method to isolate mask differences. This is a controlled experiment, not a comparison of final production fill methods or LaMa.
- Layout: render the production overlay function with fixed translations and actual planned safe boxes, including an explicitly labeled diagnostic rendering of production-blocked regions. Record font sizes, fit warnings, and box collisions at three scales. Do not confuse diagnostic rendering with approval to paint.

Ink references are manually selected text polygons with a fixed grayscale threshold, not independently annotated dense segmentation. Antialiasing and unresolved touching N/W are excluded from scoring. References are never inputs to candidate mask generation. `reference-view.png` makes the scope reviewable. Metrics count source text coverage, changed protected dark ink, and remaining dark source-text pixels. Crop inference timing and whole-page layout timing are incomparable.

## Findings and changes

Raw segmentation leaves significant glyph remnants. Selecting connected components by mean model support recovers the ordinary English and Japanese glyphs, but damages bottle details on the hard case; it cannot establish per-word ownership of a shared N/W component. This candidate therefore remains offline. The touching case also has overlapping proposed layout boxes and text covering art despite zero overflow warnings.

Two actual overlay defects were fixed in source: automatic font-size bounds and padding now scale in image coordinates, and automatic sizing considers the widest word from `Intl.Segmenter` so Thai words are not split simply to retain a larger font. Manual sizing remains user-controlled. The installed application is unchanged in this work session.

Validation: 208 unit tests, the font editor end-to-end regression, the new font scaling/Thai word test, three metric sanity tests, and desktop JavaScript syntax checks passed. Reference overlays, cleaned images, and Thai output were visually inspected.

## Source-local text placement follow-up

The backend now finds a text rectangle within the original reading bounds, excluding remaining source ink and other readings (including review-only readings). Filled residual contours protect the inside of line artwork, rather than treating the white center of a bottle as available text space. A three-pixel ink margin keeps text away from those contours. Failure to find a rectangle disables painting; success never clears existing cleanup review gates.

The plant diagnostic changes from one pair of overlapping text boxes to none, and avoids the manually annotated bottle, moon, and plus-sign areas. The two other cases also have zero box/art collisions at 60%, 100%, and 150%. `node scripts/render-reader-pipeline.cjs --assert-placement` checks these outcomes and overflow. Pixel-backed tests check that text stays within its source area and outside artwork, including an enclosed empty interior. All 208 unit tests and both font end-to-end tests passed. This changes placement only, not the unresolved bottle cleanup. No new application was installed.

## Supported-mask follow-up

Added an offline candidate that requires both model confidence and geometric support from measured OCR lines. When no line observations exist, support falls back explicitly to the reading region (the Japanese fixture). Terminal dots require terminal punctuation in the recognized text and a supported host line. Components classified as non-text remain protected after dilation. No reference polygons are inputs to mask generation.

The plant reference was visually audited to remove mislabeled moon/frame strokes and include character tips. All candidates were rescored on reference revision 3; old and new aggregate counts are not directly comparable. The new mask covers the 7652 evaluated text pixels with zero changed protected dark-ink pixels on this development crop. Touching N/W remains outside the scored reference, and whole-crop cleanup does not establish per-reading stroke ownership. The controlled fill still leaves 31 dark pixels near the panel border. These observations are not a whole-page accuracy result.

A fresh OCR run on source page 0004 supplied a fourth crop (a connected balloon). The candidate implementation hash was frozen before this run and remains checked by the benchmark. The first fixed-parameter result missed strokes and OCR added a comma after `go!!!`. A follow-up development variant removes clipping of selected components to the OCR rectangle: actual glyph strokes outside that tight rectangle are retained. This improves the displayed clean but does not turn the fourth image into an untouched holdout success. Its coarse pixel reference still needs close review at glyph ends and the balloon border.

An optional offline fill experiment uses the median of a highly uniform white neighborhood; other components retain Telea. It does not eliminate the plant border residue and is not a LaMa evaluation. The HTML report compares the original frozen candidate and follow-up candidates and labels final-image previews as diagnostic. Application cleanup permissions and installed files are unchanged. Seven metric/mask/fill checks and placement assertions for four crops at three display scales pass.

The placement harness now measures scaled computed padding rather than a fixed three-pixel subtraction. It allows 1/32 CSS pixel for Chromium's fractional rectangle rounding and uses the renderer's existing one-pixel scroll-size tolerance. This prevents touching edges from being reported as overlaps at 60% scale; it does not expand production layout bounds.

## Acceptance before promotion

Do not promote a mask method solely because coverage rises: protected-art damage must also pass, and abstained text must remain counted as unfinished. Before releasing the experimental cleaner, freeze the follow-up parameters and score newly reserved, manually annotated pages covering stylized Latin, vertical Chinese/Japanese, textured backgrounds, and touching effects. Then evaluate inpainting on confirmed masks, including a LaMa comparison. No passing broad held-out evaluation or LaMa comparison has been completed by this benchmark.

## 1.6.91 integration — limited real-page validation

The user accepted small residual artifacts and readable combined dialogue, and authorized continuing into the real workflow. The supported-component cleaner is now connected to the final production placement pass. The existing CTD model supplies a probability crop with at least 384 pixels of context where image bounds permit; OCR line support selects complete glyph components. Uniform white neighborhoods receive a median fill, with Telea elsewhere. Dark backgrounds, excluded regions and unavailable model output retain the previous path. Model failures are recorded per region. Existing shared-stroke review gates remain.

Whole-page testing exposed two integration defects that the cropped benchmark did not cover: crop rereading shifted rectangles but not polygons, and surface-based regrouping could undo already localized paragraphs. Polygon coordinates now share the source-image frame, and independently localized paragraphs are not regrouped merely because they share a white surface. A rejected crop's fragment fully covered by a longer, high-confidence accepted line does not steal that line's cleanup ownership; independent neighboring lines remain protected. Font size warnings now use source-image pixels consistently with font fitting.

`node scripts/check-reader-live.cjs` runs fresh English OCR, production refinement/cleanup, real Google Web translation and the production overlay on pages 0003 and 0004. The final run translated 14 and 12 regions and painted 12 and 10 respectively, with zero provider failures or font-fit warnings. OCR/layout/translation timings were 23.96/2.64/3.38 seconds and 9.41/3.74/1.82 seconds on this machine. These timings exclude model installation and are not a broad performance guarantee. `READER_REUSE_OCR=1` is available for layout diagnosis and is explicitly marked in results; the final run did not use it.

Evidence: `test-results/reader-pipeline/live/report.html`, `summary.json`, source/result JSON and full-page screenshots. Visual review still shows faint source outlines, isolated unerased letters, and original dialogue retained by review gates. Translation wording and table layout also need further evaluation. These are partial usable results, not complete-page accuracy certification. Broad multilingual held-out evaluation and LaMa remain unfinished.

Validation passed: 213 Node tests, two production Python mask/ownership tests, and font scaling/Thai word and font editor Electron checks. The helper is included in the Python worker cache hash and packaged source verification so an old worker cannot silently reuse the previous cleanup implementation.

Release verification: installer exited 0; all 139 source files in installed app.asar match the workspace at version 1.6.91. The installed executable was launched successfully. The live-page test above ran against the matching source before packaging; it was not repeated against the installed executable.

## 1.6.92 display and closed-balloon fixes

The connected-balloon native composite was clean while its downscaled browser overlay showed faint original glyph outlines. The transparent patch and original image were being resampled independently. Patch alpha now includes a two-pixel rim of unchanged bright source pixels; cleanup pixels are unchanged. `pixels` continues to count alpha coverage, and `cleanupPixels` reports the actual cleanup mask separately. This avoids increasing the erasure mask simply to hide rendering ghosts.

The placement obstacle builder could fill a closed balloon's outer border as though the entire enclosed area were artwork. For validated surfaces it now excludes that outer border before filling interior artwork contours. Enclosed drawings inside the balloon remain obstacles. On the same two pages this releases four placements in total: 12 to 14 and 10 to 12, without clearing shared-stroke review gates. Counts refer to accepted translation regions, not all source text.

Validation: 213 Node tests; three production Python tests including enclosed interior artwork; and a new Electron patch test comparing the overlay with a native composite at 60%, 80%, 100%, and 150%, with zero excess-dark pixels at its threshold. Real page images were inspected before and after. LaMa and remaining conflicted OCR regions are still unfinished.

Final 1.6.92 verification: fresh OCR (no reused results) plus real translation painted 14/14 accepted translations on page 0003 and 12/12 on page 0004, with zero provider failures or fit warnings. Installer exited 0 and 139 installed source files matched the workspace. Counts exclude unresolved source regions. Installed executable launched; full-page tests ran against the matching source.

## 1.6.93 reported angled-note case

Foreign reading protection now rasterizes the measured line polygon when available instead of its enclosing rectangle. Cleanup ambiguity counts actual source ink, not the blank dilation margin. Interior text placement uses the same polygon exclusion. Connected source strokes that actually cross the foreign polygon remain protected.

Overlap review now uses the selected positioned recognition evidence. A geometrically contained, matching suffix cannot block the longer high-confidence sentence; the fragment itself remains excluded. This releases the top translator note without unconditionally clearing overlap review.

A targeted Latin deskew retry accepts only a high-confidence extension of the original reading, with limited added length. Its coordinates are transformed back into the original image and old translation provenance is invalidated. The reported slanted note changes from `I don't kno` to `I don't know`. Angled and rotated Latin notes can use a rotated text rectangle only when its footprint fits verified available space; manual box changes revert to normal rectangular layout. Collision checks use the rotated footprint, and conflicting placements retain the existing fallback.

The live check now explicitly requires the top note, `I don't know`, and `A labeat` speech region to appear in the actual translated overlay. The reported page paints 15 regions instead of 12; this is not a claim that every source mark on the page is handled. Five Python geometry/ownership tests, 215 Node tests, and the Electron font test (including 68-degree and -90-degree text at three scales) pass. A fresh full-page OCR run passed; a final layout/render rerun reuses those OCR results after extending unchanged-background alpha coverage to light gray backgrounds. Small punctuation residue and other unresolved regions still need follow-up; LaMa remains unimplemented.

1.6.93 installed successfully (installer exit 0); all 140 installed source files match the workspace. Installed executable launched. Full-page evidence is from the matching source pipeline, not a second run against the installed executable.
# Detection audit and boundary preservation — 1.6.94

The 589 source images form 23 chapter groups; they are an inventory, not 589 annotated or passing pages. Generated `__mobile_pipeline*` images are excluded from sampling. The corpus harness now fingerprints source helpers recursively and selects samples deterministically.

New geometry references cover one familiar English dialogue/table page (16 units), one empty artwork page, a Japanese sibling page (12 units), and one isolated Chinese vertical caption crop. Chinese coverage remains partial relative to its original page. Japanese/Chinese text is untranscribed, so CER is unknown. Effect-ignore areas and approximate hand-marked glyph bounds limit these scores.

`scripts/benchmark-ocr-detection.cjs --phase current` captured fresh OCR in 42.746 seconds for these four inputs, including startup and planning. This is not a full-corpus speed benchmark. `--phase final --reuse current` reuses the exact hashed raw OCR and reruns planning with final code. Reports are in `test-results/ocr-detection/final/report.html`; raw, planned and translation-eligible outputs are scored separately, using one-to-one geometry matching. An unmatched box may represent a split or a badly localized detection, not necessarily nontext.

Final results: English raw/planned match 16/16 with one extra detection; eligible matches 16/16 with no scored extra, split, merge or duplicate. Empty artwork has zero outputs. Japanese raw/planned matches 9/12 and eligible 8/12: two signs and a tiny speech unit are unmatched; one further speech unit is withheld. Chinese crop matches 1/1; this establishes neither full-page Chinese recall nor recognition accuracy.

The English before/after comparison uses identical cached full-page OCR with real crop refinement. Previously, planning merged two explicitly segmented balloon parts, reducing matched units from 16 to 15. Group resolution now preserves distinct parts, including against a transitive third-observation bridge; genuine positioned duplicates remain mergeable. This initially exposed a cleanup gate regression that withheld both parts. Pixel inspection showed separate whole glyph components touched only by padded neighboring line polygons. Cleanup now uses exclusive full-component containment backed by recognized text polygons; it never cuts a shared stroke or assigns by centroid. Shared, crossing, patch-clipped, and rectangle-only evidence remains conservative. A few antialias pixels can remain around protected edges.

Validation: 231 Node tests, 12 learned-cleanup Python tests and 7 pipeline-metric Python tests passed. A real Google translation/cleanup/render run on two cached-OCR English pages painted 16 and 17 regions without fit warnings. Render counts include material outside the scored dialogue scope and are not accuracy scores. Original effects, minor cleanup residue and Japanese misses remain visible; this release does not claim the OCR work is complete.
# Japanese partial-line recovery — 1.6.95

Fresh four-input evaluation: `test-results/ocr-detection/japanese-recovery/report.html`. Two rejected Japanese sign proposals now retain confirmed source lines (`第三`, `明都学園`) after original/contrast Paddle agreement, distinct inference fingerprints, per-line confidence and geometry validation. No single glyph or generative whole-sign reading is promoted. The original proposal bounds, alternatives and agreement evidence remain inspectable. Recovered partial regions cannot merge into automatic reading units and remain excluded from translation until reviewed. OCR Lab labels them as partially read.

Japanese geometry matches increase 9/12 to 10/12, but this is **not** an increase in fully read or automatically translated groups: the new sign match contains an unconfirmed remainder. Eligible matches stay 8/12; geometric unmatched outputs increase from 1 to 2 due to the retained separate heading. The ornate banner, tiny enclosed interjection and conflicting laugh readings still require further work. Diagnostics found no supported tiny detection after generic finer tiles or enlargement. A direction correction experiment did not improve eligibility and was removed.

English stays 16/16 eligible, empty artwork stays at zero outputs, and the Chinese isolated crop stays 1/1. These four inputs do not establish corpus-wide or transcription accuracy. Node tests: 241 passed, including the partial-merge regression. This release improves review evidence, not automatic completion of the remaining Japanese page.
