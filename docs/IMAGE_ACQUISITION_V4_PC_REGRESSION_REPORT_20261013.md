# ImageHarvest — V4.0 PC-first real-site regression audit

Date: 2026-10-13 (Asia/Bangkok). Scope: existing ImageHarvest PC acquisition paths only. **V4.0 release gate: NO-GO; Mobile unchanged.**

> WARNING: Raw discovered images, sample SHA tests, reader slots, filtered UI cards and complete pages are distinct. A sample does **not** qualify a full chapter. Controlled truncation at 24 scroll steps is a QA budget, not proof of a site defect.

## Immutable starting point

- Repository: `E:\Shared\ExportImagefromWeb`, branch `main`, HEAD `40f17ae23a90055b774c285b95869a6c00a67e20`.
- Frozen before-state: `test-results/v4-pc-regression-20261013/before-state.json` (36 source/docs/APK hashes, production settings checksum only; 35 preexisting tracked dirty entries).
- Desktop package 1.6.95. Initial Android build APK SHA-256: `c60431c4e221ba90f84291d53a5f1ce90169c114550080568d472a075b4d0738` (read only).
- Never cleared cookies, personal profiles, history or installed apps. No Git stage/commit/reset and **no Mobile source edits or installs**.
- After-state check: `test-results/v4-pc-regression-20261013/preservation-check.json` confirms 20 snapshotted Mobile files, APK and production settings hashes are unchanged. Only `src/chrome-minimal.cjs` and `test/chrome.e2e.cjs` were newly modified among preexisting tracked files.

## Completed reproduction and controls

- PC Chrome Standard/Electron controlled tests: `npm run test:sites` 4/4; `node test/adaptive-production.e2e.cjs` passed; `node test/capture.e2e.cjs` passed; `npm run test:chrome` 10/10; `npm run test:filters:chrome` 10/10 (byte-preserving filtered exports, public preview filtering).
- PC Chrome Minimal initially had a reproducible launcher lifecycle failure. Windows Chrome 155 cleanly exits its first launcher with code 0 before the app-owned debugging endpoint becomes reachable. Fixed `src/chrome-minimal.cjs` to use endpoint readiness instead of treating exit 0 as a crash. `npm run test:minimal` now passes 11/11 (after updating stale test expectation for optional request-only adblock `Fetch.enable`).
- Live matrix: **39 exact chapter/viewer URL cases across 32 hostname(s)**. Chrome Minimal with independent QA profile, bounded 24 scroll steps and SHA samples (first/middle/last). All observations below are *not* a chapter completeness PASS.
- Matrix JSON: `test-results/v4-pc-regression-20261013/live-minimal-2026-10-13T12-08-27-028Z.json`.
- Preliminary abandoned matrices included a test-harness `require` sandbox error; fixed this before the final 39-case run. Those early matrices must not be used for site attribution.

## Live 39-case result summary

| Evidence outcome | Cases | Interpretation |
|---|---:|---|
| `partial-truncated` | 22 | 24-step QA cap reached: full scroll unqualified; three sampled assets may still pass |
| `sample-verified-coverage-unproven` | 12 | some sample bytes matched SHA/metadata, but logical page coverage not established |
| `byte-failure` | 3 | at least one sampled raw source could not be acquired; examine source lifetime / fetch |
| `error` | 1 | page failed to load |
| `timed-out` | 1 | navigation/load timeout |

### Per-case PC acquisition stage (not a chapter-completeness rating)

| Case | Host | HTTP | Raw candidates | SHA samples | First failing / unproven stage | Status |
|---|---|---:|---:|---:|---|---|
| Pengi-golden | pengi.co | 200| 61 | 3 | `coverage-proof` | `partial-truncated` |
| NTRNaja-golden | ntrnaja.com | 200| 11 | 3 | `coverage-proof` | `sample-verified-coverage-unproven` |
| CCharem-golden | ccharem.cileclo.com | 200| 1 | 1 | `coverage-proof` | `sample-verified-coverage-unproven` |
| BookWalker-preview | bookwalker.jp | 200| 309 | 3 | `coverage-proof` | `sample-verified-coverage-unproven` |
| MangaDex-reported | mangadex.org | 200| 35 | 3 | `coverage-proof` | `partial-truncated` |
| Manhwaread-reported | manhwaread.com | 200| 7 | 0 | `byte-transfer` | `byte-failure` |
| MangaBlackCat-reported | mangablackcat.com | 200| 16 | 3 | `coverage-proof` | `partial-truncated` |
| MangaPlus-1030315 | mangaplus.shueisha.co.jp | 200| 34 | 2 | `byte-transfer` | `byte-failure` |
| MangaPlus-1001834 | mangaplus.shueisha.co.jp | 200| 32 | 1 | `byte-transfer` | `byte-failure` |
| nhentai-visible-2 | nhentai.net | —| 0 | 0 | `page-load` | `error` |
| Nekopost-latest | www.nekopost.net | 200| 18 | 3 | `coverage-proof` | `sample-verified-coverage-unproven` |
| Nekopost-9 | www.nekopost.net | 200| 83 | 3 | `coverage-proof` | `partial-truncated` |
| MangaDex | mangadex.org | 200| 10 | 3 | `coverage-proof` | `sample-verified-coverage-unproven` |
| Readtoon | readtoon.com | 200| 12 | 3 | `coverage-proof` | `partial-truncated` |
| NTRNaja-96 | ntrnaja.com | 200| 25 | 3 | `coverage-proof` | `partial-truncated` |
| CCharem | ccharem.cileclo.com | 200| 1 | 1 | `coverage-proof` | `sample-verified-coverage-unproven` |
| Manga168 | manga168x.com | 200| 23 | 3 | `coverage-proof` | `partial-truncated` |
| NiceOppai | www.niceoppai.net | 200| 31 | 3 | `coverage-proof` | `partial-truncated` |
| MangaIsekaiThai | www.mangaisekaithai.net | 200| 11 | 3 | `coverage-proof` | `sample-verified-coverage-unproven` |
| Tanuki | www.tanuki-manga.net | 200| 18 | 3 | `coverage-proof` | `sample-verified-coverage-unproven` |
| MangaNeko | manga-neko.com | 200| 47 | 3 | `coverage-proof` | `partial-truncated` |
| GoManga | www.go-manga.com | 200| 102 | 3 | `coverage-proof` | `partial-truncated` |
| DarkManga | www.dark-manga.com | —| 0 | 0 | `page-load` | `timed-out` |
| ZenManga | www.zen-manga.com | 200| 64 | 3 | `coverage-proof` | `partial-truncated` |
| Oremanga | www.oremanga.net | 200| 43 | 3 | `coverage-proof` | `partial-truncated` |
| UpManga | www.up-manga.com | 200| 76 | 3 | `coverage-proof` | `partial-truncated` |
| BlackManga | www.black-manga.com | 200| 81 | 3 | `coverage-proof` | `partial-truncated` |
| 1668Manga | 1668manga.com | 200| 86 | 3 | `coverage-proof` | `partial-truncated` |
| MurimManga | murim-manga.com | 200| 73 | 3 | `coverage-proof` | `partial-truncated` |
| SpeedManga | speed-manga.org | 200| 48 | 3 | `coverage-proof` | `sample-verified-coverage-unproven` |
| PedManga | ped-manga.com | 200| 101 | 3 | `coverage-proof` | `partial-truncated` |
| Paomanga | paomanga.com | 200| 82 | 3 | `coverage-proof` | `partial-truncated` |
| FrankManga-latest | frank-manga.com | 200| 121 | 3 | `coverage-proof` | `partial-truncated` |
| FrankManga-153 | frank-manga.com | 200| 98 | 3 | `coverage-proof` | `partial-truncated` |
| BullyManga | bully-manga.com | 200| 105 | 3 | `coverage-proof` | `partial-truncated` |
| MangaLC | manga-lc.net | 200| 27 | 3 | `coverage-proof` | `sample-verified-coverage-unproven` |
| MangaZaa | manga-zaa.net | 200| 72 | 3 | `coverage-proof` | `sample-verified-coverage-unproven` |
| SnapManga | www.snap-manga.com | 200| 71 | 3 | `coverage-proof` | `partial-truncated` |
| Tanuki-9.1 | www.tanuki-manga.net | 200| 18 | 3 | `coverage-proof` | `sample-verified-coverage-unproven` |

## Last-known-good PC golden-content comparison (full-candidate SHA + decode)

After the 39-case sweep, reran the exact previously exported chapters with 120-step budget and up to 150 byte/decoder inspections in an isolated QA profile.

| Archive | Historic bytes | Observed now | Exact SHA/order recovered | Source decoding | Remaining caveats |
|---|---:|---:|---:|---|---|
| NTRNaja-golden | 10 | 11 raw | **10/10** exact; order preserved | 11/11 decoded & dimensions match; 0 source errors | 11 raw = 10 archived reader images + 1 extra UI image; current semantic total still not independently proven |
| Pengi-golden | 43 | 61 raw | **43/43** exact; order preserved | 54/61 decoded & dimensions match; 6 source errors | 61 raw includes extra non-golden sources; 6 sampled extra sources HTTP 403; 1 dimension metadata mismatch. No access-control bypass. |
| CCharem-golden | 30 | 1 raw | **0/30** exact; order preserved | 1/1 decoded & dimensions match; 0 source errors | Only one non-reader image; no Canvas content from this direct SPA deep link. |

- NTRNaja: the **10/10 old exported JPEG SHA-256 values match in the same ordinal order**; 11th image is not declared a manga page. Historical content parity is evidenced.
- Pengi: **all 43/43 old WebP SHA-256 values survive in ordinal order 1–43**; do not call the other 18 raw sources new manga pages. Generic collector still returned 6 HTTP 403 on non-archived sources. Historical content parity is evidenced, not total current-site completeness.
- CCharem: **0/30 historical Canvas page hashes recovered**. Current direct reader URL responds HTTP 200 but displays a generic SPA shell with zero Canvas and zero IMG in the DOM diagnostic. The prior PC success entered reader through the detail-page SPA. This is unresolved **reader-discovery / entry-route**, not evidence V3 caused an acquisition regression.
- Full comparison JSON: `test-results/v4-pc-regression-20261013/live-minimal-2026-10-13T12-19-45-048Z.json`; comparator: `test-results/v4-pc-regression-20261013/compare-full.cjs`.

## Site-specific outstanding blockers (do not mark green)

- **Manhwaread:** document HTTP 200, 7 raw sources, tested acquisition failed with `TypeError: Failed to fetch` at byte transfer. Distinguish live browser-owned response, cross-origin access, expired resource and actual HTTP rejection before making any change.
- **MANGA Plus:** reader pages HTTP 200, 34/32 raw candidates but sampled `blob:`/browser-owned source reads failed (`TypeError: Failed to fetch`). The Mobile 27 files / 29 slots result is separate and **partial**, not 27 verified story pages.
- **nhentai:** supplied page timed out at network page load; no availability assertion or bypass.
- **DarkManga:** Chrome Page.navigate timed out before reader evidence; classify as network/navigation until reproduced.
- **BookWalker:** landing-page scan observed 309 raw assets (154 UI-visible), not 309 content pages. Prior 18 small public preview images remain a historic preview-only golden; no paid-reader qualification.
- **MangaDex, Readtoon and other 24-step truncated sites:** some initial assets load and hash, but need reader-sized image selection, longer scroll and proof of end/order. The QA cap explains partial status, not necessarily the site.
- **Comix.to, Hitomi and any reader lacking an archived exact chapter URL:** not tested live in this sweep. Do not substitute a synthetic fixture for a real-site PASS.

## Next authorized work within V4.0

1. Qualify content/slot semantics separately from raw UI asset counts: filters on/off with excluded reasons, reader-page ordinals, full export bytes/dimensions, stable end proof, and explicit partial states. Use archived PC hashes for 10/10 NTR and 43/43 Pengi gates.
2. Investigate CCharem from the *detail-page SPA entry*, MANGA Plus Blob lifetime and Manhwaread browser-response ownership in isolated QA only. Never retry protected 403/401/429 by bypass, never replay one-shot bytes just to force a green result.
3. Re-run remaining sites at chapter-appropriate budgets; mark changed/unavailable sites and unknown pages honestly, do not lower acceptance counts. Preserve previously-proven legacy acquisition route as fallback.
4. Only after the PC real-site golden matrix is accepted, compare Mobile legacy vs V3 (separate QA builds), and then proceed to V4.1/V4.2 typed reader evidence and page maps. Rust authority and performance work remain later gates.

**Verdict: PC archive NTRnaja/Pengi historical image parity is confirmed. Overall PC V4.0 cross-site release gate is NOT met; Mobile remains untouched.**
