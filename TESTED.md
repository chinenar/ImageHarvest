# Verification - ImageHarvest 1.0.10

Verified on 18 September 2026 (UTC+07:00).
Base commit: a58e979; existing DNS, capture-session and blob-reader features retained.
Electron 44.4.1; Playwright Core 1.63.0; electron-builder 26.15.3 / NSIS.

## Regression checks
- Unit and DNS/site-rule tests: 24/24 passed on SaKuRa-PC.
  The archived Pengi-source hash/syntax check skips when the private local audit fixture is absent.
- Existing Electron E2E: 20/20 passed (`test-results/run-1789677456015`).
- Collection/curation E2E: 19/19 passed (`test-results/curation-1789677474528`).
- Chrome E2E: 10/10 passed (`test-results/chrome-1789677485772`).
- Native-response and non-mutating-scroll checks: 4/4 passed (`test-results/sites-1789677452817`).
- Capture-session workflow: passed (`npm run test:capture`).
- Blob revocation / tall-image scrolling workflow: passed (`npm run test:blob`).
- Packaged EXE smoke: passed; version 1.0.10, new option present and off by default.

The new local fixture accepts a browser image request once and rejects replay requests.
Both exported images matched the source bytes and incurred no replay requests.
Scrolling and restoration left inline styles and the document time origin unchanged.
Site-rule tests check exact origins, unchanged 403 behavior and refusal of unknown Pengi code.

## Live packaged-application verification
The app's actual Open, Scan, selection and Download workflow was exercised on the two
previously supplied public chapter URLs. The test harness did not inject an extra site patch;
the packaged application's opt-in site-compatibility feature performed the handling.
A fresh app-owned Chrome profile was used; no personal profile or DevTools panel was opened.
No login, payment, access-entitlement or CAPTCHA checks were altered.
Windows Job limits bounded each live test to 180 seconds and 3 GiB total committed memory.

| Live case | Primary images present after scan | Exported | Failed | Format |
| --- | ---: | ---: | ---: | --- |
| NTRNaja supplied chapter 0 | 10 | 10 | 0 | JPEG |
| Pengi supplied chapter 1 | 43 | 43 | 0 | WebP |

- NTRNaja: 11 scan results total; 10 reader images selected, excluding the site logo.
  Initial DOM exposed 5 reader images; scrolling discovered 001.jpg through 010.jpg.
- Pengi: 60 scan results total; 43 reader images selected, excluding other page content.
  Auto-scroll completed in 67 rounds without changing the document time origin.
- Every selected export had contiguous page filenames, the observed DOM order,
  and a SHA-256 matching the original Chrome response snapshot.
- The 10 JPEG files total 43,464,556 bytes; 43 WebP files total 6,398,796 bytes.
- All 53 exported files subsequently decoded from disk with Chrome while HTTP(S)
  requests were disabled. Every hash and image dimension matched the manifest.
- Results are scoped to these chapter URLs and this reviewed site version, not every chapter.

Local evidence (ignored by Git; manga files are not published):
- `test-results/live110-ntrnaja-1789677730586/`
- `test-results/live110-pengi-1789677796026/`
- Each has result.json, verified-export/report.json and offline-verification.json.

## Installed build
Installed and launched on SaKuRa-PC and SaKuRa-Notebook; both report version 1.0.10.
Existing per-user paths were retained under `%LOCALAPPDATA%\Programs\ImageHarvest`.
Installer: `installer-dist/ImageHarvest-Setup-1.0.10.exe` (113,419,890 bytes).
SHA-256: `4B39795E808F654915A5A3AF63F39CD5AE6473598E5DBE404880A0EE4DEB5FEB`.
The installer remains an assisted installer with selectable installation directory.
Site compatibility is opt-in and only applies to exact recognized domains in Chrome mode.
Pengi's recognized reader bundle must pass the pinned hash check before modification.
