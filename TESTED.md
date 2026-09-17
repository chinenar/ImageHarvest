# Verification — 2026-09-17

App version: 1.0.2
Electron: 44.4.1
Installer: electron-builder 26.15.3 + NSIS

- Unit tests: 9/9 passed (`npm test`).
- Electron end-to-end checks: 19/19 passed (`npm run test:e2e`).
- Packaged Windows executable smoke check passed with the new reverse-order and rename-tool controls.
- Assisted NSIS installer built successfully with selectable installation directory.
- Installer SHA-256: `7183DBA0CDB02F4EEC3688DC16F45763F74960386632905062252368A8EA1D1C`.
- Installed successfully on SaKuRa-PC and SaKuRa-Notebook.
- Both machines report ImageHarvest 1.0.2 and have Desktop + Start Menu shortcuts.
- Installed app launched successfully on both machines with the `ImageHarvest` main window.
- `npm install` reported 0 vulnerabilities at build time.

Latest E2E evidence: `test-results/run-1789654646591/` (ignored from Git).

End-to-end checks use controlled local fixture pages, not every public website.
Covered: lazy images, picture/srcset, CSS backgrounds, blob/data URLs, exact URL deduplication,
ordered file export, byte preservation, cookies/referrer, redirects, nested scrolling,
cancellation, invalid selectors, HTML rejection, size limits, HTTP 429 backoff,
one-click reverse ordering, and local-folder page renaming with natural numeric order.

See README.md for supported cases, limitations, development commands, and installer build instructions.
