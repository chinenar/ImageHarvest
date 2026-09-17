# Verification — 2026-09-17

App version: 1.0.3
Electron: 44.4.1
Installer: electron-builder 26.15.3 + NSIS

- Unit tests: 9/9 passed (`npm test`).
- Electron end-to-end checks: 20/20 passed (`npm run test:e2e`).
- Packaged Windows executable smoke check passed, including the Canvas control.
- Assisted NSIS installer built successfully with selectable installation directory.
- Installer SHA-256: `0139A699A334B9DA8D2BE8EA81BC6B8B56B697C0F151F31E2EC3FAC655570DE8`.
- Installed successfully on SaKuRa-PC and SaKuRa-Notebook; both report ImageHarvest 1.0.3.

Latest E2E evidence: `test-results/run-1789663079195/` (ignored from Git).

Canvas test coverage includes waiting for a non-blank rendered 2D canvas, PNG capture,
and retaining existing security behavior for remote pages and downloads.

## Live CCharem reader check

Tested against the public free chapter 1.1 on `ccharem.cileclo.com` using a fresh in-memory app session.
ImageHarvest did not call or decrypt the reader media API itself; it opened the reader normally and captured only canvases after the site rendered them.

- Reader exposed 19 canvas pages.
- Captured 19/19 rendered pages; scan completed in 31 steps without truncation.
- Pages 1–18 captured at 1400×2011; page 19 at 1400×794.
- Every captured item validated as a PNG file.
- No live manga images or decrypted source files are stored in the repository; temporary canvas captures are removed when the app exits or a new scan starts.

See README.md for supported cases and limitations.
