# Verification - ImageHarvest 1.0.5

Electron: 44.4.1; Playwright Core: 1.63.0 (now also a production dependency).
Installer: electron-builder 26.15.3 / NSIS, assisted installer with selectable directory.

## Regression results
- Unit: 12/12 passed.
- Existing Electron E2E: 20/20 passed (`test-results/run-1789668000450`).
- Curation E2E: 18/18 passed (`test-results/curation-1789668018891`).
- Chrome E2E: 10/10 passed from source (`test-results/chrome-1789668505457`).
- Chrome E2E: 10/10 passed using packaged EXE on SaKuRa-PC (`test-results/chrome-1789668721668`).
- Chrome E2E: 10/10 passed using installed EXE on SaKuRa-Notebook (`test-results/chrome-1789668914034`).
- Packaged application smoke test passed; version and browser selector verified.

The Chrome fixture checks a live dimension-based inspect detector, lazy Canvas capture,
image bytes, app-owned session cookies, redirects, reverse-order export, HTTP 403/429,
stream size limits, tainted-Canvas rejection, navigation to about:blank, access-gate errors,
switching back to Electron, and temporary-profile cleanup.
This is a synthetic detector, not a copy of any third-party site's full protection system.

## Installed build
Installed and launched successfully on SaKuRa-PC and SaKuRa-Notebook.
Both machines report 1.0.5; existing per-user installation paths were retained.
Installer SHA-256: `C1A123DA1E83C2C3DA6DC42264C90E340EF6B586EC7050B0695F12880E9F1631`.

A separate, read-only live compatibility check did not obtain manga images from the
third-party target: Chrome opened the pages but they navigated to about:blank.
No site's protection scripts were disabled and no personal browser profile was used.
Live evidence is kept locally under ignored `test-results/`, not published in this repo.
