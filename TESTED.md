# Verification - ImageHarvest 1.0.4

Runtime: Electron 44.4.1. Installer: electron-builder 26.15.3, assisted NSIS x64.

- Unit tests: 12/12 passed (`npm test`).
- Existing Electron end-to-end checks: 20/20 passed (`npm run test:e2e`).
- New collection/filter end-to-end checks: 18/18 passed (`npm run test:curation`).
- The same 18 collection checks passed against the packaged EXE.
- Packaged smoke test passed: version, IPC and all new controls verified.
- Installer built with a selectable installation directory.
- Installer SHA-256: `8EF9F5A18043216190499C573EADB423361318D26E1B98A6A6A432568ADEB968`.

Local evidence (ignored from Git):
- Existing E2E: `test-results/run-1789665143477/`
- Final source curation: `test-results/curation-1789665323495/`
- Final packaged curation: `test-results/curation-1789665367226/`

New checks cover opt-in metadata filters, reader prioritization, short pages,
shared image URLs in different regions, Canvas/background inclusion, source filtering,
selected-visible-only removal, cancellation, undo, clear including hidden results,
invalid IDs, busy-state protection, minimum window width and export ordering.
Hashes verified that exported files are unchanged by removal and clearing.
Unknown layouts retain uncertain images and display a warning.

Tests use controlled loopback pages, not a claim of accuracy on every public website.
No third-party manga images, browsing data or live-site test reports are published here.

Installed using the same checksum-verified installer on SaKuRa-PC and SaKuRa-Notebook.
Both installed executables report 1.0.4 and opened an ImageHarvest window successfully.
Existing installed-user paths were retained under `%LOCALAPPDATA%\Programs\ImageHarvest`.
