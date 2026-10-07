# Verification - ImageHarvest 1.6.39

## 1.6.39 — 6 October 2026: translation placement and live webpage overlays

- HarvestTS Start now selects EnhancedMangaOcrPool with the validated GPU runtime, serial page processing and a shared OCR/layout backend. Source language selects its OCR language; without the optional runtime the baseline is explicitly retained. OCR engine/device metadata remains truthful.
- Successful current translations map original-image coordinates to the actual image element, with padding/border and object-fit/object-position geometry. Isolated SVG erase masks plus centered, wrapped Thai-capable text fit the layout boxes. Weak contours use tight rectangular masks; non-flat surfaces use flat cover rectangles, not texture inpainting. Original images remain unchanged.
- Scroll, responsive resize, lazy image replacement, original toggle, original-toggle resize, SPA chapter clearing and restrictive CSP passed headless browser coverage. Constructor stays serialized into the sandboxed page; no Node access added to websites. Incremental anchors retain existing text elements across unrelated page mutations.
- OCR Lab sends reviewed Harvest results or captured viewport results back to their linked source tab. Captures preserve URL/tab/scroll/viewport/DPR; reflowed captures are withheld and request recapture. Serialized original capture hides launcher/translation overlays and restores them. Two-page source HarvestTS E2E passed actual GPU OCR/layout, mocked AI, overlay text/count/font checks, Lab reconnect and capture reconnect. Source Lab E2E passed.
- Real supplied rooftop manga page: actual GPU OCR → Google Translate → layout → web overlay produced ten Thai translations, preserving the RITHAR SCANS logo and uncertain architecture. A discovered layout regression treating the known mark as a bubble is fixed by retaining its confirmed role across automatic surface inference; explicit content/bubble override remains available. npm test: 103/103. Evidence: test-results/translation-overlay/geometry.json, live-google-result.json, translated-manga.png and self-contained translated-manga.html.

- Final installed 1.6.39.0 verification: installer exit 0, all 58 application source files match ASAR. Installed two-page GPU/mocked-AI E2E passed overlays, fonts, actual Lab import/show-on-web buttons and captured-viewport reconnect. Installed real Google rooftop page passed 10/10 eligible translated overlays, zero fit warnings, 17.215s total including startup/network. Final PNG inspected; known mark preserved and weak first AH contour no longer leaves source glyphs. Overlay regression also covers clipping-ID uniqueness during partial page updates. Evidence: test-results/translation-overlay/report.md and install-verification.json; test-results/harvest-translation-1791256281444/result.json. Installer SHA-256 68843e5ce2abe8ab603a7131df9d56d0df5af683721196a12dcf5dd12dbfb798.

## 1.6.38 — 6 October 2026: GPU OCR and bounded batches

- Isolated official PyTorch 2.11.0+cu128 and Paddle GPU 3.2.2/cu126 runtimes verified on RTX 4070 Super. Manga OCR uses CUDA FP32; Paddle detection and recognition use gpu:0. Base CPU packages and oneDNN overlay retained. No other local AI model unloaded.
- Shared Paddle detector plus recognition-only line batching; crops preserve preprocessing-specific detection. Two candidate jobs/two input crops per worker batch, four Paddle lines per inference batch. Tesseract ROI work stays serial; outputs collected in original candidate order. Batch language/engine, cardinality, response association and queue cancellation covered. GPU allocation failure replays the same request once on CPU; unrelated errors remain explicit.
- Same frozen pages, cache bypassed: first/warm English 8.645/4.222 s, Japanese 14.113/9.055 s, authored Thai 1.067/.709 s. Benchmark initialized the worker before page timing; these figures exclude that startup. All reference units retained (8/8, 11/11, 3/3), no measured merges/splits. Matched English/Thai readings exact; Japanese retains the previous one-character error. Japanese final texts/boxes identical to frozen CPU output. English unmatched SFX reading changed but remains incorrect. Thai bounds have small GPU polygon differences; strict localization remains below target.
- Initial user-page GPU check: 20.040 s versus previous CPU 186.275 s; same twelve selected texts and same role exclusions, including What's that?, RITHA/SCAN and uncertain building artwork. Timings depend on loading and competing system work.
- npm test 100/100; OCR regressions 47/47, zero skips/failures. The additional Python GPU-memory fallback regression and its Node test passed separately. Full-page 99% is not established.
- Installed 1.6.38.0, silent installer exit 0; all 57 application source files match ASAR. Installed Lab E2E passed with an explicit CUDA assertion and GPU run-history label. Source hidden-window PNG captures passed; installed hidden capture stalled and was replaced with renderer-state JSON diagnostics so OCR/geometry/cancellation/UI checks could complete. CPU-only real Thai inference also passed.
- Final source rerun: English 8.637/3.637 s, Japanese 14.058/8.467 s, synthetic Thai .958/.751 s (first/warm, excluding initial worker startup). Four-language user page 18.459 s including worker startup; all twelve texts unchanged. Eleven boxes identical, YES? horizontal edges inset by one source pixel. Evidence: gpu-report.md, gpu.json, gpu-quality.json, gpu-user-page-review.json, install-verification.json, ocr-lab/thai-cropped-fixed.json and enhanced-comparison.state.json. Installer SHA-256 d0c390f220fa95c58236288121c04c5924f9ec0dc4c0df117e5aafa3f0740b31.

## 1.6.37 — 6 October 2026: desktop OCR performance and screenshot regressions

- Isolated PaddlePaddle 3.2.2 CPU accelerator enables oneDNN without the locally reproduced 3.3.1 PIR/oneDNN exception. Paddle/OpenMP/Torch use four threads. Same models, original/CLAHE full/detail discovery coverage and variant voting remain; unconfirmed Japanese proposals are gated before Manga OCR retries.
- Three exact-source regression pages preserve every reading and bounding box (English 9, Japanese 13, synthetic Thai 3). Previous recorded times 260.1/197.7/41.6s; first accelerated run 75.1/91.5/18.8s; final build rerun 123.5/100.2/10.4s under concurrent QA load. These are observed runs with variable model warmth/load, not a controlled benchmark or full-corpus accuracy claim.
- Bounded Lab result cache isolates raw data from edits, keys image/settings/ROI/scale, and supports bypass. Installed E2E cache round trip was 6ms with identical observations; scale changes invalidate cache. Reuse timings are not inference timings.
- Exact user's rooftop screenshot located at set 2, chapter 4, 0002.webp. Real four-language full-page run: 186.3s, 7 CTD and 14 Paddle scans. Recovers What's that? from independently agreeing positioned lines and tightens its box; consolidates duplicate AH with both observations retained. All 10 spoken outputs remain eligible. Low-confidence architecture proposal remains visible but is withheld from automatic translation; the known RITHAR SCANS logo (clipped OCR RITHA/SCAN) is tagged/skipped. Japanese SFX completeness remains unverified.
- Shared translation service skips confirmed watermark/manual non-text and unreviewed low-confidence observations by default, retaining reasons and raw OCR. Lab shows classifications, manual non-text/watermark choices, restoration to story content and optional uncertain inclusion. Generic scans, color, short dialogue or edge positions alone do not classify a watermark.
- Final npm test 100/100; npm run test:ocr 45/45, zero skips/failures. Final source/installed Lab E2E passed cache identity/bypass/invalidation, manual role override, original/AVIF imports, ROI/scale geometry, long pages, portable save/load and immutable raw results. HarvestTS translation pipeline E2E with mocked provider passed. Installed live Google 23/23 and local AI 2/2 passed connectivity/provenance checks.
- Silent installation exit 0, installed 1.6.37.0; all 57 inspected application source files match ASAR bytes. Evidence: test-results/ocr-speed/report.md, after.json, install-verification.json, user-page-result.json, user-page-review.json, user-page-checked.png and test-results/ocr-lab/cache-verification.json. Full-page 99% and a universal watermark detector are not established.

## 1.6.36 — 6 October 2026: OCR-to-translation connection

- OCR Lab now translates corrected OCR through Google Translate Web or a selected local AI model. Per-region results preserve ids, source text/hash, image digest, bounding box, orientation, OCR review flags, provider/model and run history. Editable OCR and raw observations remain separate; source/box edits mark translations stale. Portable save/reopen retains translations.
- Shared service bounds batches (125-region regression), normalizes OCR line wraps, validates ids, retries omissions and wrong-script results, records failures and supports cancellation. Script checks are a heuristic and do not establish semantic translation accuracy.
- Local LM Studio native model metadata verifies capability before requesting reasoning off through /api/v1/chat with store false. Other servers fall back to compatible chat completions. Initial 27B compatible call timed out; 9B with reasoning on exhausted its output before delivering a message. Native reasoning off returned two Thai dialogue translations in roughly 2 seconds. A 3B model emitted Japanese/mixed script; such responses now fail rather than count as translated. Native/fallback behavior and active cancellation have mocked unit coverage.
- Live source and installed app tests: Google English-to-Thai 7/7, Japanese-to-Thai 13/13, synthetic Thai-to-English 3/3; qwen3.5-9b-uncensored-hauhaucs-aggressive Japanese-to-Thai 2/2 with scene context. Excluded the English watermark and a known bad SFX reading from translation; retained all original OCR regions in saved project. These are connectivity/provenance tests, not a translation-accuracy benchmark.
- HarvestTS now invokes real translation after OCR for both providers. Deterministic two-page HarvestTS E2E exercises the actual OCR/placement stages and a mocked HTTP AI endpoint; asserts translations, ids, original text and image hashes.
- Final npm test: 96/96. Translation-specific tests: 17/17. OCR regressions passed 37/37 before two additional placement tests were added concurrently; those additional cases are included in the final npm test pass.
- Source and installed translation E2E passed: live providers, UI buttons/model/context selection, source-edit invalidation, raw immutability, translated project save/reopen and hidden screenshot. Evidence: test-results/ocr-translation/live-report.json, report.md, translated-review.json, lab-translation.png, install-verification.json.
- Installer exit 0, installed version 1.6.36.0; nine source modules match installed ASAR. Installer SHA-256 a118040143600b7f2a8a0ed326cd6be6c61c1f5921b99618b02340af2b019d49 (346167334 bytes).


## 1.6.34 — 6 October 2026: independent discovery, preprocessing and outlined balloon groups

- CTD now has a full scan plus overlapping detail scans for large normal pages in the enhanced engine. Independent Paddle PP-OCRv5_server_det scans original/CLAHE tiles, retains proposals and conflicts, and does not join existing speech units. Matching padded Paddle polygons to actual CTD lines fixes duplicate YOU/HIM proposals observed in an English real-page run.
- Seven preprocessing variants: original, grayscale, autocontrast/contrast, invert, CLAHE, adaptive Gaussian threshold and Otsu. Automatic retries use uncertainty/agreement; all-variant mode is explicit. Japanese automatic retries use CLAHE/adaptive and recropping. Crop alternatives record scale, padding, masks and source coordinates. The Lab reconstructs those exact crops for previews; unsafe/out-of-bounds preview geometry is rejected. Both axes use actual rounded resize dimensions; 2x line polygons return to source pixels.
- Colored/gradient balloons use enclosed outline components. Border-connected background is excluded. Broad, offset connections can be split using two opposite inward bends only across a text-row gap with at least two rows per side. A frozen real Japanese connected-dialogue crop now yields two exact readings; the existing English shared-row connected-balloon test still passes. A single colored ellipse with a continuous paragraph remains one unit. Unsupported supplemental Japanese output stays rejected instead of promoting Manga OCR hallucinations.
- `npm test`: 73/73. Final `npm run test:ocr`: 33/33, zero skips/failures. Includes crop/scale regressions, connected Japanese/English, cancellation, independent discovery, seam deduplication, negative artwork, threshold pixels, masked preview reconstruction and source-coordinate mapping.
- Source OCR Lab E2E and final installed executable E2E passed: original/AVIF imports, screenshot origin, long-page selection, portable save/load, raw immutability, all seven alternatives, preview UI/API, invalid preview rejection, 2x polygons, exact cropped Thai reading, one Thai region and truthful partial/recognition-only measurements. Native capturePage with stayHidden/stayAwake avoids a Playwright screenshot timeout while QA windows stay hidden.
- Full-page real English reference: 8/8 labeled dialogue/caption/watermark units, exact matched readings, no merges/splits after duplicate fix. Stylized SFX remain outside the partial reference and one emits an incorrect reading. Latest real Japanese rerun: 11/11 labeled dialogue units, no merges/splits, 1 character error across 179 matched reference characters (99.4413% matched-reading accuracy); 10/11 meet IoU >= .8. Two recognized whispers are outside that partial reference. Neither run establishes full-page 99% accuracy.
- Independent authored Thai synthetic page: 3/3 units, no extras/merges/splits and exact text, including close white/gradient balloons and floating text. Mean IoU .7342; strict localization target fails. This is controlled synthetic evidence, not an independent Thai manga holdout. Reference hashes were frozen before evaluation; per-run engine hashes distinguish pre-fix and final Japanese results. Evidence: `test-results/ocr-advanced/reference.json`, `final/report.json`, `final/review.json`, `ja-connection-fixed.json/.png` and `test/fixtures/ocr-ja-connected.*`.
- Silent installer exit 0; installed version 1.6.34. All 12 inspected OCR source files match installed ASAR bytes. Installer `installer-dist/ImageHarvest-Setup-1.6.34.exe`: 346162171 bytes, SHA-256 1ED939BCE9BDF2EF728A82D0BC6748CA74F880EB37EC4C7C84C228CA1CBCB196. Verification: `test-results/ocr-advanced/install-verification.json`. Detailed CPU scans take longer; whole-corpus 99% and SFX completeness remain unverified.

## 1.6.33 — 6 October 2026: cropped Thai paragraphs and duplicate groups

- Five real-image crop boundaries at preprocessing scales 1×/2×/3× produce one horizontal text unit, retaining all three source lines. Small screenshots are no longer enlarged excessively for CTD; the effective detector scale accounts for Lab preprocessing.
- Full Thai source plus three cropped images read the manually transcribed three-line paragraph exactly. Thai crop padding retains tone marks; supported recognizer line bounds extend the overlay while preserving detectorBBox. This reuses one bubble and is a regression check, not independent Thai accuracy evidence.
- Shared-line overlapping block observations are consolidated. Identical line sets under different containers are emitted once; neighboring units without the same observed lines stay separate. A replay of cached detector observations from 515 images changes grouping on 3 pages, removing duplicates. It does not measure new full-page accuracy.
- OCR Lab displays the current application version and each OCR run's version; old unversioned results remain marked unknown. Manual split provenance is visible in the inspector. Automated QA windows are hidden with background rendering enabled, keeping transient manual edits out of the user's working view.
- npm test: 73/73; npm run test:ocr: 20/20, no skips. Existing adjacent balloons, connected staggered English balloons, Japanese vertical coordinates, long-page overlap, HEIN/POURQUOI, cancellation and truthful evaluation checks pass. Electron source/packaged checks passed, and the final installed executable passes the Lab E2E including an enhanced full cropped-image run at 2×, exact reading, one region, and source-pixel bounds.
- Final silent installation exit 0; installed version 1.6.33. All 10 inspected OCR source files match installed ASAR bytes. Installer: installer-dist/ImageHarvest-Setup-1.6.33.exe, 346134500 bytes, SHA-256 4117f00e78484aebaaef7f8c5bd21e2172dd940109657b9d06530d22c8759e1c.
- Evidence: test-results/thai-split/grouping-audit.json, install-verification.json, fixed.png and review.json; test-results/ocr-lab/thai-cropped-fixed.json and thai-cropped-fixed.png. The latest screenshot's exact historical split could not be reproduced from its overlaid pixels; tests use the untouched source image. Whole-corpus 99% remains unverified.

## 1.6.32 — 6 October 2026: optional local engines and recognition comparison

- Separate local JSON-lines worker: manga-ocr 0.1.16, PaddleOCR 3.7.0 with explicitly selected PP-OCRv5 models, PaddlePaddle 3.3.1. Images stay local; the optional runtime/model cache is outside the installer. Missing runtime, process exit, concurrent startup and cancellation are handled explicitly.
- Fixed-crop reference: 60 visually transcribed crops, 2 no-text controls, source/crop SHA-256 and original source ROI. Four ambiguous/incomplete candidates excluded before model evaluation. Earlier inspected cases are development data; independent EN/JA page-4–6 holdout has 19 crops/470 reference non-whitespace characters.
- Holdout primary character accuracy: Tesseract 79.1489%, selected enhanced readings 98.5106%, exact crops 15/19. English 99.1329%, Japanese 96.7742%. NFKC/ellipsis-normalized secondary score 99.1266%; primary score preserves punctuation and small kana. No independent Thai/French holdout, and the Thai crops reuse the same bubble. These results do not establish full-page detection/localization or 99% over the corpus.
- Connected English balloon subset: 2/2 units, no merges/splits, character accuracy 100%, mean IoU 0.9103, partial reference and targetMet false. Other text on that page remains outside the reference.
- Real runtime checks include vertical Japanese with null confidence, Thai full-page CTD crop, source-coordinate line mapping, optional-runtime absence and cancellation/restart. Source Electron checks include enhanced 2× ROI (uncertain tone differences remain flagged), raw/alternative immutability, run history, portable comparison project and explicit recognition-only metrics.
- `test-results/engine-comparison/report.json`, report.md, reference.json, results.json and comparison-review.json retain scope, errors and source evidence. Full-crop reading and actual page detection are separate checks; Thai crop geometry still affects tone recognition.
- Final checks: npm test 73/73 and npm run test:ocr 17/17, no failures/skips. OCR Lab E2E passed in source, win-unpacked and installed executables, including the optional Python sidecar, enhanced ROI coordinates, comparison controls and portable recognition-only project.
- Installed 1.6.32 successfully (installer exit 0). Installed ASAR matches the detector, both OCR pools, Python/Node sidecar, lab service, renderer, HTML and CSS. CTD SHA-256 remains 1a86ace74961413cbd650002e7bb4dcec4980ffa21b2f19b86933372071d718f. Installer: installer-dist/ImageHarvest-Setup-1.6.32.exe, 346133244 bytes, SHA-256 F28FE21A442BF06686E00CFDCFBBD61689978C5AE38BDF9C740710891D5F3410.

## 1.6.30 — 6 October 2026: new manga datasets, AVIF and long pages

- New sets 2–7: 456 images, 0 engine errors, 3005 retained regions and 216 rejected observations. No complete reference exists; counts are not accuracy. Detailed flags and projects: test-results/new-sets/report.md and set-N/review.json.
- 107 long images use overlapping tiles. Original coordinates are valid across all retained regions; empty/uncertain text remains visible for review.
- npm run test:ocr: 12/12 passed, including tile coverage/deduplication, exact recognition and original positions at both ends of a 16,000px raster, mixed languages and the prior reported manga split. npm test: 73/73 passed.
- Electron OCR Lab source and win-unpacked executable pass AVIF import, AVIF ROI at 2×, source digests, long-page recognition, 400% zoom with a bounded bitmap, real pointer selection near y=14,624, portable projects and the earlier capture/measurement tests.
- Original source-image hashes gate reference selection. Other datasets cannot inherit the first-set dialogue reference. Outlined/white text and SFX still cause reading errors and omissions; 99% is unverified.

## 1.6.28 — 6 October 2026: manga detector and independent text groups

- 59 local first-set manga images completed with zero engine errors: 475 retained regions, 11 rejected observations preserved in the review project.
- First-page partial reference of nine dialogue/caption/punctuation units: 9/9 matched, no merges or splits; character accuracy 91.15%, localization recall 88.89%. Japanese SFX are outside this partial reference and remain missed. Other pages have no verified reference. This does not establish 99% accuracy.
- `npm test`: 73/73 passed. `npm run test:ocr`: 10/10 passed, including the actual reported manga page and mixed Japanese vertical / English / Thai raster fixture.
- Electron OCR Lab passes actual import/OCR, source coordinates, 2× ROI remapping, truthful tone-error scoring, edit/split, immutable raw observations, portable project, guest screenshot, and HEIN / POURQUOI separation.
- Native runtime and sharp binaries are unpacked; ONNX model bytes are read through Electron filesystem APIs. Upstream model license and checksum accompany the asset.

## 1.6.27 — 6 October 2026: OCR Lab

- `npm run test:ocr`: 8/8 passed, including actual raster OCR with Japanese vertical, English neighboring balloons, and Thai text.
- `npm run test:ocr-lab`: passed real Electron import/OCR, source-pixel ROI, 2× preprocessing coordinate remapping, one-to-one scoring, split, immutable raw observations, portable JSON save/load, and actual HarvestTS capture with scroll metadata and restored launcher visibility.
- Supplied Thai bubble: raw multi-pass result found the expected speech unit, but also 4 false detections from artwork and one missing tone mark. Against a manually specified text/bbox reference: recall 100%, precision 20%, character accuracy 90.74%, mean IoU 94.59%. It does not meet the 99% target.
- Manual correction can pass against the reference; this is tested separately and must not be presented as automatic OCR accuracy.
- Fixed float-model recognition crash with a worker-local ordinary SIMD workaround for Tesseract.js 7 issue #1080. Native OCR errors are returned instead of crashing the application.
- Evidence: `test-results/ocr-lab/report.json`, `test-results/ocr-lab/lab.png`; fixture image and unit/engine tests are under `test/`.

Verified 18 September 2026 (UTC+07:00), based on commit 94ad587.
Electron 44.4.1; Playwright Core 1.63.0; electron-builder 26.15.3 / NSIS.

## Scope and implementation
The runtime no longer selects compatibility rules by hostname, URL path or filename.
It recognizes three reviewed complete script contents using pinned SHA-256 hashes.
Relocating identical content is supported; arbitrary forks, minified rebuilds or inline
versions are NOT automatically covered. Library names alone are diagnostic hints.
Unknown ordinary scripts are left unchanged and reported. A recognizable unknown
memory-exhaustion pattern is refused instead of executed or guessed-patched.
Chrome and automatic known-script compatibility are the new defaults; both browser
choice and an explicit disabled compatibility preference can be saved.
Image response capture works for all Chrome pages, including when compatibility is off.
No browser CSP/CORS/SRI, authorization, login, payment or CAPTCHA checks are disabled.

## Regression results on SaKuRa-PC
- Unit/network/compatibility: 30/30 passed, no skips in this environment.
  Three archived-source checks skip explicitly if local audit fixtures are missing.
- Generic compatibility actual-UI E2E: 8/8 passed from source.
  Evidence: `test-results/generic-1789680476758/`.
- Generic compatibility actual-UI E2E: 8/8 passed from packaged 1.1.0 EXE.
  Evidence: `test-results/generic-1789680814451/`.
- Native-response/scrolling fixture: 4/4 passed (`test-results/sites-1789680510460/`).
- Existing Electron E2E: 20/20 passed (`test-results/run-1789680513647/`).
- Curation E2E: 19/19 passed (`test-results/curation-1789680532161/`).
- Chrome E2E: 10/10 passed (`test-results/chrome-1789680616485/`).
- Capture Session and blob-revocation/tall-reader workflows: passed.
- Packaged EXE smoke: passed, version and default settings verified.

The generic fixture serves the two reviewed standalone libraries from 127.0.0.1 and
localhost under unrelated, renamed and extensionless paths. Both origins apply the
same content rules. Ordinary scripts, timers and unknown-name-only scripts keep running.
It verifies original image bytes, redirect aliases, no replay requests, no style mutation,
unchanged document time origin and snapshot availability after Chrome closes.
The 429 test separates blocked NEW requests from already-cached offline bytes.
No unrequested image GET occurs after the host's request gate is tripped.

## Fresh live tests with packaged 1.1.0
The actual UI Open/Scan/Download workflow was tested with the two earlier supplied
public chapter URLs, using the default generic engine (no domain-specific switch or
extra patch injected by the test runner). A fresh app-owned Chrome profile was used.
No personal login profile or visible DevTools panel was used.

| Case | Primary images selected | Exported | Failed | Applied content rules |
| --- | ---: | ---: | ---: | ---: |
| NTRNaja supplied chapter 0 | 10 | 10 JPEG | 0 | 2 |
| Pengi supplied chapter 1 | 43 | 43 WebP | 0 | 1 |

The NTRNaja export totals 43,464,556 bytes; Pengi totals 6,398,796 bytes.
All 53 exported files have contiguous filenames, observed reader DOM order, and
SHA-256 matching Chrome's original response snapshot. All 53 were decoded again from
disk with HTTP(S) requests blocked, confirming hashes and intrinsic dimensions.
Both readers retained the same document time origin during scanning.
Evidence is local and Git-ignored; third-party manga files are not published:
- `test-results/generic-live-ntrnaja-1789680879107/`
- `test-results/generic-live-pengi-1789680908388/`
Each contains result.json, verified-export/report.json and offline-verification.json.

## Installer and deployment
Installer: `installer-dist/ImageHarvest-Setup-1.1.0.exe`, 113,421,268 bytes.
SHA-256: `85BFD43FFBBE084906F5B2817F8000593D0C22B5EEBBB02E499D07EB3437FB9A`.
Installed and launched successfully on SaKuRa-PC and SaKuRa-Notebook.
Both executable versions report 1.1.0; installation paths were preserved under
`%LOCALAPPDATA%\Programs\ImageHarvest`. Installed-EXE smoke checks passed on both PCs.
The installer still provides a selectable installation directory.

## Deliberate limitations
Only exact reviewed script contents are automatically modified. The three signatures
are not a promise of support for every version of the corresponding library families.
Inline scripts, arbitrary rebuilt bundles, all worker/OOPIF contexts and scripts above
analysis budgets are not covered. Integrity checks and access challenges remain in force.
Service Worker startup is blocked only inside app-created Chrome while compatibility
is enabled; dependent websites may need the option disabled and the page reopened.
Unknown ordinary scripts remain unchanged. A narrow recognizable dangerous-memory
pattern is blocked for safety; this is not a complete malicious-script detector.
No third-party reader source, cookies, private Chrome profiles or manga exports are
included in the repository. Archive-dependent tests clearly identify missing fixtures.

Additional installed-application verification on SaKuRa-Notebook:
- Packaged smoke passed.
- Generic compatibility real-Chrome UI tests: 8/8 passed on the installed EXE.
- Evidence: `test-results/generic-1789681191352/` (shared path mounted as W: on notebook).


## 1.2.0 — 18 September 2026: Minimal Chrome release

Executed results (SaKuRa-PC):
- Existing npm test: 30 passed, 0 failed (process 41104).
- Source Standard Chrome local regression: 10 passed, 0 failed; test-results/chrome-1789713328901/results.json.
- Source Minimal Chrome local regression: 11 passed, 0 failed; test-results/minimal-1789713053746/results.json.
- Packaged Minimal Chrome local regression: 11 passed, 0 failed; test-results/minimal-1789713410084/results.json.
- Source app, live CCharem provided chapter: found 31 items including logo; selected and saved 30/30 Canvas PNGs, failed 0, 54,303,712 bytes. Valid file hashes and decoded dimensions verified; no script rewriting; no Runtime.enable/Console.enable/Debugger.enable. Evidence: test-results/live120-minimal-ccharem-1789713182748/result.json and verified-export/report.json.
- NSIS build succeeded under installer-dist/build-1.2.0; installation verified FileVersion 1.2.0 and normal app launch. Settings backed up and Chrome Minimal selected for this user; see test-results/install120-result.json.

Not completed / not proven:
- Live Minimal NTRnaja attempt: tool safety gate blocked the execution before a website test result. This is NOT a website-side failure.
- Live Minimal Pengi: not run. Do not reuse historical Standard-with-patches results as Minimal evidence.
- Packaged live CCharem rerun: tool-blocked; source live and packaged local results above remain separate evidence.
- New test/cdp-transport.test.cjs exists but its execution was tool-blocked and is not counted among passed tests.

Minimal keeps browser security defaults and the existing tainted-Canvas SecurityError behavior. A test pass on this chapter and browser setup is not a guarantee for every website, browser version, login, or paid chapter. No website source or production deployment was modified. No Git commit/push was performed during this update.

## 1.3.0 — Workspace Tabs + Pre-read
Executed results (SaKuRa-PC, source):
- `npm test`: 30/30 passed.
- Curation + new tab/Pre-read regression: 21/21 passed; evidence `test-results/curation-1789717868587/`.
- Existing Electron E2E: 20/20 passed; evidence `test-results/run-1789717581250/`.
- Capture Session and blob-scan workflows: passed.
- Chrome Minimal: 11/11 passed; evidence `test-results/minimal-1789717609566/`.
- Chrome Standard: 10/10 passed; evidence `test-results/chrome-1789717639108/`.
- Packaged 1.3.0 Curation/Workspace/Pre-read: 21/21 passed; evidence `test-results/curation-1789717992695/`.
- NSIS build succeeded at `installer-dist/build-1.3.0/ImageHarvest-Setup-1.3.0.exe` (113,427,537 bytes; SHA-256 `C13172910BA5847055567C8963B5802395182C06EC3E7312C75048F3751113B1`; FileVersion 1.3.0).

Workspace tabs keep independent URL/result/order/selection/filter state. Switching is blocked while scan/capture/export is busy, and one browser engine remains active at a time. Pre-read is an in-app continuous viewer only; it does not rewrite or concatenate original image files.

## 1.4.0 — 18 September 2026: contextual filters and incremental scan UI

Source checks executed on SaKuRa-PC:
- npm test: 39/39 passed, zero skips (30 existing + 9 filtering/pixel-classifier tests).
- Existing curation/tabs/Pre-read: 21/21; test-results/curation-1789719974643/.
- New actual-UI filter + streaming suite: 10/10 Electron; test-results/filter-stream-electron-1789720431869/.
- New actual-UI filter + streaming suite: 10/10 Chrome Minimal; test-results/filter-stream-chrome-1789720440046/.
- Existing Electron E2E: 20/20; test-results/run-1789720461370/.
- Capture-session and blob-scan workflows: exited successfully.
- Chrome Minimal: 11/11; test-results/minimal-1789720486609/.
- Chrome Standard: 10/10; test-results/chrome-1789720515314/.

Live actual-UI checks used the four exact user-supplied URLs, fresh app-owned Chrome Minimal profiles, and no clicks on outbound advertising, purchases, logins, or sample-reader navigation. Results are local-only and include signed URLs, so raw reports are not published.
Evidence: test-results/filters-live-baseline-1789719326706/ and test-results/filters-live-improved-1789720079705/.

| Site | Raw occurrences | Prior filtered | Updated metadata filter | Optional blank filter | Streamed batches |
| --- | ---: | ---: | ---: | ---: | ---: |
| Nekopost | 18 | 13 | 4 | 4 | 10 |
| Manga168x | 28 | 22 | 12 | 12 | 16 |
| MangaDex | 10 | 4 | 1 | 1 | 4 |
| BookWalker | 169 | 111 | 18 | 17 | 37 |

The baseline's identifiable page images were retained byte-for-byte by fingerprint in the metadata-filtered results (4, 12, 1, and 18 respectively). Assertions are recorded in verified-content-preservation.json in the improved folder. The one BookWalker solid-white page is retained when blank filtering is off and hidden only when on. No renderer errors occurred; all scan-items batches arrived while the scan was busy. Synthetic tests also verify actual decoded thumbnails before scan completion, late-event rejection, placeholders becoming real pages, single-pixel content, tab state, filtered byte-preserving export, and cancel/partial-result synchronization.

These counts do not certify completeness beyond the observed pages. MangaDex was in its initial single-page reader view and showed one content image in this run. BookWalker checks cover the 18 small public preview images, not a paid book. Filters are reversible heuristics, not recognition of arbitrary image content. The sampled blank-page check can miss tiny/faint detail; unknown/unsupported data is kept. Website origin-clean/CORS and existing access checks remain unchanged. Selection/deletion redesign and split-image reconstruction are out of scope. No Git commit/push or notebook installation is part of this update.

Packaged 1.4.0 verification completed: new Chrome Minimal filter/streaming suite 10/10 (test-results/filter-stream-chrome-1789721044971/); existing curation/tabs/Pre-read suite 21/21 (test-results/curation-1789721066063/). NSIS build completed successfully under installer-dist/build-1.4.0.

Desktop installation completed at 2026-09-18T15:46:19.3866181+07:00. Verified normal running UI (PID 14144) exposes the new hideBlank/hideChrome labels, Add Tab and Pre-read. Installed app.asar SHA-256 matches the tested packaged archive. Existing settings were preserved byte-for-byte. Before restarting the idle old app, 131 acquired snapshot files were copied and hash-verified under E:\Shared\ExportImagefromWeb\test-results\install140-safe-20260918-154556. The backup includes prior accessible UI metadata but is not an automatic session/order restoration. No user export files were changed.

Installed executable filter/streaming E2E: 10/10 Electron, test-results/filter-stream-electron-1789721221885/. Installer: 113430614 bytes, SHA-256 13D7574A427F5362F58B2500271C5CE8806B6198A453E24CA64F87764676C486. Desktop only; no notebook deployment and no Git commit/push.

## 1.5.0 — 20 September 2026: Manga mode + continuous next-chapter harvesting

Source checks executed on SaKuRa-PC:
- Syntax checks passed for `core.cjs`, `main.cjs`, `renderer.js`, and `preload.cjs`.
- `npm test`: 54/54 passed, zero skips.
- Electron E2E after the final SPA/action preference changes: 21/21 passed; evidence `test-results/run-1789924430018/`.
- Continuous E2E starts at folder 7 and verifies exact folders `7`, `8`, `9`, ordered originals, and per-folder reports.
- UI E2E verifies **เว็บทั่วไป** is the default, continuous controls are hidden there, and **มังงะ / มังฮวา** reveals chapter automation.
- Chapter numbers are compared as integer parts: 1.10 follows 1.9; dotted/hyphenated forms such as `1.2` and `ตอนที่-6-3` are supported without float ordering or blind URL +1.
- Next detection covers direct URLs, `rel=next`, chapter selectors, sibling URLs, opaque chapter IDs/UUIDs with direction icons, semantic buttons without href, JavaScript/hash controls, disabled-last-chapter controls, and chapter-index fallback.
- Next Page and Previous controls are rejected; semantic-click navigation must actually change URL/title/heading before continuous mode proceeds.
- Existing numeric output folders fail closed instead of silently receiving a suffix.

Live actual-browser verification used app-owned Chrome and opened or clicked through to the detected next chapter, then verified the final URL/title. Confirmed transitions include: Nekopost 9 → 9.5; MangaDex Chapter 1 → 2 via opaque UUID + right-chevron SVG; Readtoon 9 → 10; Pengi 1 → 2 via UUID; two NTRNaja patterns; Manga168 37 → 38 via semantic button; NiceOppai 22 → 23; MangaIsekaiThai 6.3 → 6.4; Tanuki 1 → 2 via chapter-index fallback; Tanuki 9.1 → 9.2 on the live site; Manga-Neko 1 → 2; Go-Manga 33 → 34; Dark-Manga 12 → 13; Zen-Manga title 114 → 115 despite URL suffix 36 → 37; Oremanga 33.2 → 34; Up-Manga 1188 → 1189; Black-Manga 37 → 38; Murim-Manga 10 → 11; Ped-Manga 10 → 11; PaoManga 69 → 70; Frank Manga 153 → 154; Bully-Manga 10 → 11; Manga-LC 10 → 11; Manga-Zaa 10 → 11; and Snap-Manga 1 → 2.

Expected safe stops / external blocks:
- Nekopost 9.5: Next controls are disabled and selector has no higher chapter, so automation stops.
- Frank Manga 154: Next control is disabled; Frank 153 → 154 verifies the detector itself works.
- 1668Manga: Cloudflare behavior was inconsistent across runs. One Standard run reached/scanned the reader, while later Minimal/Standard runs remained on security verification; final status is access-gated/flaky rather than a verified detector failure.
- Speed-Manga: current response is `Access Denied` / site suspended, now classified as gated before scan.
- CCharem's old route `/read/little-sister/1.1` and direct server request to the current reader deep link return HTTP 404. However, entering the current reader through its live manga detail page works client-side: ImageHarvest scanned the 1.1 reader Canvas content, preferred the semantic SPA Next control over the inferred deep-link URL, and successfully advanced 1.1 → 1.2. Therefore CCharem Next logic is verified; the remaining issue is the site's direct deep-link/server-history routing.

Final 1.5.0 package verification:
- NSIS build completed at `installer-dist/build-1.5.0/ImageHarvest-Setup-1.5.0.exe`.
- Packaged Windows smoke test passed after the final Web/Manga, SPA-action, URL-canonicalization, and chapter-index changes.
- Installer size: 113,438,432 bytes.
- Installer SHA-256: `E6F3CD6BF3B58EAC0CF6D16DBC227CDBE202A4EBB8EE7DA33550E3EB422BE021`.

No Git commit/push or notebook deployment is part of this update.


## 1.5.1 — 21 September 2026: confidence filtering + continuous recovery

Filtering changes:
- Content filtering remains deterministic and local; no AI classifier or hostname allow/deny list was added.
- The classifier now records chrome/content confidence scores and evidence signals instead of relying only on binary labels.
- Collector context now includes nearby ancestor metadata and link text, allowing generic support/donate/membership CTA artwork to be recognized.
- The reported `support-us-1.png` pattern is covered by unit and actual-UI fixture regression; it is classified as promo outside reader content.
- Broad words such as `banner`, external hosts, wide aspect ratios, or outbound links alone remain insufficient to hide content.
- Enabling continuous Manga mode turns on the reversible chrome/promo filter by default; the user can still turn it off.

Continuous-mode recovery changes:
- Next-chapter detection is retried up to 3 times before a safe end-of-series stop.
- Direct next-URL opening and chapter scans are retried up to 3 times for transient failures, with short backoff and a post-navigation settle delay.
- Semantic Next-button actions are not blindly double-clicked; the existing verified-change/fallback path remains in control to avoid skipping chapters.
- Blank-page analysis timing out no longer aborts the whole run; uncertain images are kept instead of risking loss of a real page.
- A JSONL diagnostic log records session start/end, completed folders and recovery attempts under the app userData `logs/continuous-session.log` path.

Verification on SaKuRa-PC:
- `npm test`: 55/55 passed, zero failures/skips.
- Source filter/streaming E2E: 10/10 passed; evidence `test-results/filter-stream-electron-1789927606449/`.
- Source Electron E2E: 23/23 passed; evidence `test-results/run-1789927614977/`.
- The continuous E2E verifies exact folders 7/8/9, automatic promo-filter enablement, readable JSONL diagnostics, and three safe rechecks at the final chapter before stopping.
- Packaged Windows smoke passed against `installer-dist/build-1.5.1/win-unpacked/ImageHarvest.exe` and verified version 1.5.1 plus the new diagnostic IPC.
- Packaged filter/streaming E2E: 10/10 passed; evidence `test-results/filter-stream-electron-1789927741473/`.
- `git diff --check` passed before the release build; only line-ending conversion warnings were printed.

Final 1.5.1 package:
- Installer: `installer-dist/build-1.5.1/ImageHarvest-Setup-1.5.1.exe`.
- Size: 113,439,930 bytes.
- SHA-256: `EDDF20F43D720CA52219F3B2BC4D836B83BC4199A82D68C4EEA0D3892F037516`.
- Packaged FileVersion: 1.5.1; ProductVersion: 1.5.1.0.

This update was built and tested but not installed over the user's existing 1.5.0 installations in this release step. No Git commit/push was performed.


## 1.6.1 — 28 September 2026: Pengi reader guard hotfix

Root cause:
- Pengi replaced its integrated reader/DevTools guard bundle. The prior reviewed content signature from 1.1.0 no longer matched.
- ImageHarvest correctly classified the replacement as an unsafe unknown guard and failed closed before scanning; this was not a content-filter failure.
- The new exact script content hash is `0314a2a1037bf0a5abb4cc270ed0a1d309e858bd8df81b5053833906807b9b7a`.
- Added reviewed rule `reviewed-reader-guard-build-2` using the existing structure-checked isolation transform. Unknown unsafe scripts still remain blocked.

Verification on SaKuRa-PC:
- Current supplied Pengi chapter: 12 primary pages found, selected 12, saved 12/12, failed 0, same document retained.
- Standard Chrome live smoke: Nekopost 15 images, Manga168 28 images, MangaDex 10 images; all completed without compatibility errors.
- `npm test`: 56/56 passed, 0 failed/skipped.
- The existing unknown memory-exhaustion regression remains fail-closed.

Packaged 1.6.1 verification:
- Packaged Windows smoke passed against `installer-dist/win-unpacked/ImageHarvest.exe`.
- The packaged 1.6.1 EXE repeated the current Pengi live test successfully: 12/12 saved, 0 failed, same document retained, reviewed build-2 rule applied.
- Installer: `installer-dist/ImageHarvest-Setup-1.6.1.exe`, 113,446,920 bytes.
- SHA-256: `686660FCB864C7741633C398324550C38E77C4A953B5A11DFD2876E933B21488`.
- FileVersion 1.6.1; ProductVersion 1.6.1.0. No installation or Git commit/push was performed.

Installed 1.6.28 was rechecked on 6 October 2026: source files match the workspace, model SHA-256 matches the bundled provenance, and the installed Electron executable passed OCR Lab including the reported real-page split.

Installed 1.6.30 matches the current detector, OCR pool, lab service and renderer. Installed-executable OCR Lab checks passed, including AVIF, 16000px OCR and 400% bottom-region pointer selection.
