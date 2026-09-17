# Verification - ImageHarvest 1.1.0

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
