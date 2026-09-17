# Verification - ImageHarvest 1.0.8

Electron 44.4.1; Playwright Core 1.63.0; electron-builder 26.15.3 / NSIS.

## Regression results
- Unit/network: 18/18 passed.
- Existing Electron E2E: 20/20 passed (`test-results/run-1789674789884`).
- Capture Session fixture: passed.
- Blob revocation/tall-reader fixture: passed.
- Curation E2E: 19/19 passed (`test-results/curation-1789674816073`).
- Chrome E2E: 10/10 passed (`test-results/chrome-1789674827185`).
- Packaged application smoke test: passed; version 1.0.8 and network controls verified.

## Smart Auto live checks
On SaKuRa-PC, packaged 1.0.8 with network mode Auto used Cloudflare Secure DNS for the reported domains. Both Hitomi URLs opened, the nhentai gallery opened, and the nhentai page URL reached a Cloudflare `Just a moment...` access gate instead of timing out. No challenge/403 bypass was attempted.

Installer: `installer-dist\ImageHarvest-Setup-1.0.8.exe`
SHA-256: `CE2C879FA227AD7CFD0B22F30889A7C8F9F8EDA471048547250C2F16F97612C7`
