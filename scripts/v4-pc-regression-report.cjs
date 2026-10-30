'use strict';
// Rebuild the PC-first V4.0 regression report exclusively from isolated QA evidence.
const fs=require('node:fs'), path=require('node:path');
const root=path.resolve(__dirname,'..');
const evidence=path.join(root,'test-results','v4-pc-regression-20261013');
const main=JSON.parse(fs.readFileSync(path.join(evidence,'live-minimal-2026-10-13T12-08-27-028Z.json')));
const golden=JSON.parse(fs.readFileSync(path.join(evidence,'live-minimal-2026-10-13T12-19-45-048Z.json')));
const snapshot=JSON.parse(fs.readFileSync(path.join(evidence,'before-state.json')));
const md=[];
const s=(...lines)=>md.push(...lines);
s('# ImageHarvest — V4.0 PC-first real-site regression audit',
  '',
  'Date: 2026-10-13 (Asia/Bangkok). Scope: existing ImageHarvest PC acquisition paths only. **V4.0 release gate: NO-GO; Mobile unchanged.**',
  '',
  '> WARNING: Raw discovered images, sample SHA tests, reader slots, filtered UI cards and complete pages are distinct. A sample does **not** qualify a full chapter. Controlled truncation at 24 scroll steps is a QA budget, not proof of a site defect.',
  '',
  '## Immutable starting point',
  '',
  '- Repository: `E:\\Shared\\ExportImagefromWeb`, branch `'+snapshot.branch+'`, HEAD `'+snapshot.head+'`.',
  '- Frozen before-state: `test-results/v4-pc-regression-20261013/before-state.json` (36 source/docs/APK hashes, production settings checksum only; 35 preexisting tracked dirty entries).',
  '- Desktop package '+snapshot.packageVersion+'. Initial Android build APK SHA-256: `'+(snapshot.files['mobile/app/build/outputs/apk/debug/app-debug.apk']?.sha256||'not found')+'` (read only).',
  '- Never cleared cookies, personal profiles, history or installed apps. No Git stage/commit/reset and **no Mobile source edits or installs**.',
  '- After-state check: `test-results/v4-pc-regression-20261013/preservation-check.json` confirms 20 snapshotted Mobile files, APK and production settings hashes are unchanged. Only `src/chrome-minimal.cjs` and `test/chrome.e2e.cjs` were newly modified among preexisting tracked files.',
  '',
  '## Completed reproduction and controls',
  '',
  '- PC Chrome Standard/Electron controlled tests: `npm run test:sites` 4/4; `node test/adaptive-production.e2e.cjs` passed; `node test/capture.e2e.cjs` passed; `npm run test:chrome` 10/10; `npm run test:filters:chrome` 10/10 (byte-preserving filtered exports, public preview filtering).',
  '- PC Chrome Minimal initially had a reproducible launcher lifecycle failure. Windows Chrome 155 cleanly exits its first launcher with code 0 before the app-owned debugging endpoint becomes reachable. Fixed `src/chrome-minimal.cjs` to use endpoint readiness instead of treating exit 0 as a crash. `npm run test:minimal` now passes 11/11 (after updating stale test expectation for optional request-only adblock `Fetch.enable`).',
  '- Live matrix: **'+main.results.length+' exact chapter/viewer URL cases across '+new Set(main.results.map(x=>x.host)).size+' hostname(s)**. Chrome Minimal with independent QA profile, bounded 24 scroll steps and SHA samples (first/middle/last). All observations below are *not* a chapter completeness PASS.',
  '- Matrix JSON: `test-results/v4-pc-regression-20261013/live-minimal-2026-10-13T12-08-27-028Z.json`.',
  '- Preliminary abandoned matrices included a test-harness `require` sandbox error; fixed this before the final 39-case run. Those early matrices must not be used for site attribution.',
  '',
  '## Live 39-case result summary',
  '',
  '| Evidence outcome | Cases | Interpretation |',
  '|---|---:|---|');
const groups={};
for(const row of main.results){groups[row.state]=(groups[row.state]||0)+1;}
for(const [key,description] of [
 ['partial-truncated','24-step QA cap reached: full scroll unqualified; three sampled assets may still pass'],
 ['sample-verified-coverage-unproven','some sample bytes matched SHA/metadata, but logical page coverage not established'],
 ['byte-failure','at least one sampled raw source could not be acquired; examine source lifetime / fetch'],
 ['error','page failed to load'],
 ['timed-out','navigation/load timeout']
])s('| `'+key+'` | '+(groups[key]||0)+' | '+description+' |');
s('', '### Per-case PC acquisition stage (not a chapter-completeness rating)', '',
  '| Case | Host | HTTP | Raw candidates | SHA samples | First failing / unproven stage | Status |',
  '|---|---|---:|---:|---:|---|---|');
for(const row of main.results){
 s('| '+row.name+' | '+row.host+' | '+(row.httpStatus??'—')+
 '| '+row.scanned+' | '+row.sampleCount+' | `'+row.stage+'` | `'+row.state+'` |');
}
s('',
'## Last-known-good PC golden-content comparison (full-candidate SHA + decode)',
'',
'After the 39-case sweep, reran the exact previously exported chapters with 120-step budget and up to 150 byte/decoder inspections in an isolated QA profile.',
'',
'| Archive | Historic bytes | Observed now | Exact SHA/order recovered | Source decoding | Remaining caveats |',
'|---|---:|---:|---:|---|---|');
for(const [name,oldPath] of [
 ['NTRNaja-golden','generic-live-ntrnaja-1789680879107/verified-export/report.json'],
 ['Pengi-golden','generic-live-pengi-1789680908388/verified-export/report.json'],
 ['CCharem-golden','live120-minimal-ccharem-1789713182748/result.json']
]){
 const old=JSON.parse(fs.readFileSync(path.join(root,'test-results',oldPath)));
 const current=golden.results.find(r=>r.name===name);
 const originals=(old.files||[]).map(f=>f.sha256);
 const index=new Map((current.sampleResults||[]).filter(x=>x.sha256).map(x=>[x.sha256,x.ordinal]));
 const matches=originals.map(s=>index.get(s)).filter(Boolean);
 const ordered=matches.every((v,i)=>i===0||v>matches[i-1]);
 const decoded=(current.sampleResults||[]).filter(x=>x.decoded&&x.dimensionsMatch).length;
 const missing=(current.sampleResults||[]).filter(x=>x.error).length;
 const caveat=name.startsWith('NTR')?'11 raw = 10 archived reader images + 1 extra UI image; current semantic total still not independently proven':
 name.startsWith('Pengi')?'61 raw includes extra non-golden sources; 6 sampled extra sources HTTP 403; 1 dimension metadata mismatch. No access-control bypass.':
 'Only one non-reader image; no Canvas content from this direct SPA deep link.';
 s('| '+name+' | '+originals.length+' | '+current.scanned+
 ' raw | **'+matches.length+'/'+originals.length+'** exact; order '+(ordered?'preserved':'unproven')+
 ' | '+decoded+'/'+(current.sampleResults||[]).length+' decoded & dimensions match; '+missing+' source errors | '+caveat+' |');
}
s('',
'- NTRNaja: the **10/10 old exported JPEG SHA-256 values match in the same ordinal order**; 11th image is not declared a manga page. Historical content parity is evidenced.',
'- Pengi: **all 43/43 old WebP SHA-256 values survive in ordinal order 1–43**; do not call the other 18 raw sources new manga pages. Generic collector still returned 6 HTTP 403 on non-archived sources. Historical content parity is evidenced, not total current-site completeness.',
'- CCharem: **0/30 historical Canvas page hashes recovered**. Current direct reader URL responds HTTP 200 but displays a generic SPA shell with zero Canvas and zero IMG in the DOM diagnostic. The prior PC success entered reader through the detail-page SPA. This is unresolved **reader-discovery / entry-route**, not evidence V3 caused an acquisition regression.',
'- Full comparison JSON: `test-results/v4-pc-regression-20261013/live-minimal-2026-10-13T12-19-45-048Z.json`; comparator: `test-results/v4-pc-regression-20261013/compare-full.cjs`.',
'',
'## Site-specific outstanding blockers (do not mark green)',
'',
'- **Manhwaread:** document HTTP 200, 7 raw sources, tested acquisition failed with `TypeError: Failed to fetch` at byte transfer. Distinguish live browser-owned response, cross-origin access, expired resource and actual HTTP rejection before making any change.',
'- **MANGA Plus:** reader pages HTTP 200, 34/32 raw candidates but sampled `blob:`/browser-owned source reads failed (`TypeError: Failed to fetch`). The Mobile 27 files / 29 slots result is separate and **partial**, not 27 verified story pages.',
'- **nhentai:** supplied page timed out at network page load; no availability assertion or bypass.',
'- **DarkManga:** Chrome Page.navigate timed out before reader evidence; classify as network/navigation until reproduced.',
'- **BookWalker:** landing-page scan observed 309 raw assets (154 UI-visible), not 309 content pages. Prior 18 small public preview images remain a historic preview-only golden; no paid-reader qualification.',
'- **MangaDex, Readtoon and other 24-step truncated sites:** some initial assets load and hash, but need reader-sized image selection, longer scroll and proof of end/order. The QA cap explains partial status, not necessarily the site.',
'- **Comix.to, Hitomi and any reader lacking an archived exact chapter URL:** not tested live in this sweep. Do not substitute a synthetic fixture for a real-site PASS.',
'',
'## Next authorized work within V4.0',
'',
'1. Qualify content/slot semantics separately from raw UI asset counts: filters on/off with excluded reasons, reader-page ordinals, full export bytes/dimensions, stable end proof, and explicit partial states. Use archived PC hashes for 10/10 NTR and 43/43 Pengi gates.',
'2. Investigate CCharem from the *detail-page SPA entry*, MANGA Plus Blob lifetime and Manhwaread browser-response ownership in isolated QA only. Never retry protected 403/401/429 by bypass, never replay one-shot bytes just to force a green result.',
'3. Re-run remaining sites at chapter-appropriate budgets; mark changed/unavailable sites and unknown pages honestly, do not lower acceptance counts. Preserve previously-proven legacy acquisition route as fallback.',
'4. Only after the PC real-site golden matrix is accepted, compare Mobile legacy vs V3 (separate QA builds), and then proceed to V4.1/V4.2 typed reader evidence and page maps. Rust authority and performance work remain later gates.',
'',
'**Verdict: PC archive NTRnaja/Pengi historical image parity is confirmed. Overall PC V4.0 cross-site release gate is NOT met; Mobile remains untouched.**',
'');
const outfile=path.join(root,'docs','IMAGE_ACQUISITION_V4_PC_REGRESSION_REPORT_20261013.md');
fs.mkdirSync(path.dirname(outfile),{recursive:true});
fs.writeFileSync(outfile,md.join('\n'));
console.log(JSON.stringify({file:outfile,cases:main.results.length,distinctHosts:new Set(main.results.map(x=>x.host)).size,outcomes:groups,lines:md.length},null,2));
