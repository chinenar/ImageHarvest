# Verification — 2026-09-17

App version: 1.0.1
Electron: 44.4.1
Installer: electron-builder 26.15.3 + NSIS

- Unit tests: 8/8 passed (`npm test`).
- Electron end-to-end checks: 17/17 passed (`npm run test:e2e`).
- Assisted NSIS installer built successfully with selectable installation directory.
- Installer SHA-256: `37074D70C02D00F19605DA40A1FBE99D56A2BA7CE1462DC7EBE12EC417E49132`.
- Installed successfully on SaKuRa-PC and SaKuRa-Notebook.
- Both machines report ImageHarvest 1.0.1 and have Desktop + Start Menu shortcuts.
- Installed app launched successfully on both machines with the `ImageHarvest` main window.
- `npm install` reported 0 vulnerabilities at build time.

Latest E2E evidence: `test-results/run-1789652094046/` (ignored from Git).

End-to-end checks use controlled local fixture pages, not every public website.
Covered: lazy images, picture/srcset, CSS backgrounds, blob/data URLs, exact URL deduplication,
ordered file export, byte preservation, cookies/referrer, redirects, nested scrolling,
cancellation, invalid selectors, HTML rejection, size limits, and HTTP 429 backoff.

See README.md for supported cases, limitations, development commands, and installer build instructions.
