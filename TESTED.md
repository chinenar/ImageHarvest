# Verification - ImageHarvest 1.0.9

Electron 44.4.1; Playwright Core 1.63.0; electron-builder 26.15.3 / NSIS.

## Regression results
- Unit/network: 18/18 passed.
- Existing Electron E2E: 20/20 passed (`test-results/run-1789676134280`).
- Capture Session fixture: passed, including event-driven IMG/hash changes beating a 3s polling fallback.
- Blob revocation/tall-reader fixture: passed.
- Curation E2E: 19/19 passed (`test-results/curation-1789676160973`).
- Chrome E2E: 10/10 passed (`test-results/chrome-1789676172234`).
- Packaged application smoke and packaged Capture Session tests passed on SaKuRa-PC.

## Live reader + DNS checks
- AdGuard DNS mode opened the reported Hitomi reader and gallery URLs.
- Packaged 1.0.9 with Auto + Capture Session on Hitomi `reader/19324.html#2` captured the next page about 210 ms after the real Next control changed the hash/image, while fallback polling was intentionally set to 3,000 ms.
- Smart Auto remains Cloudflare-first/Google-backup. AdGuard is opt-in because DNS filtering can break some site assets.
- Access challenges/HTTP 403 are reported; no challenge bypass is attempted.

Installer: `installer-dist\ImageHarvest-Setup-1.0.9.exe`
Size: 113,415,649 bytes
SHA-256: `95124287107D5052259E3E32C898CB1822C6A2CE03397D623C12E4109DF8925B`
