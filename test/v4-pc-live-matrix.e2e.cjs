'use strict';
// V4.0 desktop-only, regression-first live qualification. No source/production profiles are mutated.
// Usage: node test/v4-pc-live-matrix.e2e.cjs --only=pengi,readtoon --steps=25 --samples=3
const { _electron } = require('playwright-core');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (key, fallback='') => (argv.find(x => x.startsWith('--' + key + '=')) || '').split('=').slice(1).join('=') || fallback;
const only = arg('only').toLowerCase().split(',').filter(Boolean);
const steps = Math.min(250, Math.max(5, Number(arg('steps','18')) || 18));
const maxSamples = Math.min(300, Math.max(0, Number(arg('samples','3')) || 0));
const mode = arg('mode','minimal');
if (!['minimal','standard','electron'].includes(mode)) throw Error('Invalid mode');
const runRoot = path.resolve(arg('out', path.join(root, 'test-results', 'v4-pc-regression-20261013')));
const key = s => crypto.createHash('sha256').update(String(s)).digest('hex');
function archivedTargets() {
  const source = fsSync.readFileSync(path.join(root,'test','live-next-chapter.e2e.cjs'),'utf8');
  const match = source.match(/const targets = (\[[\s\S]*?\n\]);/);
  if (!match) throw Error('Historical live-next fixture cannot be parsed: do not invent cases');
  return vm.runInNewContext(match[1], Object.create(null), {timeout:1000})
    .map(([name,url]) => ({name,url,previous:'live-next-20260920',proof:'historical-next-only'}));
}
const pinned = [
 ['Pengi-golden','https://pengi.co/read/c281fb21e4f5d10614f5160fbffa157e','verified-export-12/12-20260928'],
 ['NTRNaja-golden','https://ntrnaja.com/manga/m-zerh6ddw/?chapter=%E0%B8%95%E0%B8%AD%E0%B8%99%E0%B8%97%E0%B8%B5%E0%B9%88-0','verified-export-10/10-20260917'],
 ['CCharem-golden','https://ccharem.cileclo.com/read/น้องสาวที่น่ารักคนนี้เป็นของพี่แค่คนเดียว/5?page=1','verified-export-30/30-20260918'],
 ['BookWalker-preview','https://bookwalker.jp/de59126576-da27-4b2b-8f84-b4b89b05db9c/','18-preview-only-20260918'],
 ['MangaDex-reported','https://mangadex.org/chapter/b014d5fc-cb37-4a68-a696-55e21ff4a9b1','user-reported-not-golden'],
 ['Manhwaread-reported','https://manhwaread.com/manhwa/my-first-time-is-with-my-little-sister/chapter-60/','user-reported-not-golden'],
 ['MangaBlackCat-reported','https://mangablackcat.com/manga/the-wife-waited-in-the-wheat-field/1.0','user-reported-not-golden'],
 ['MangaPlus-1030315','https://mangaplus.shueisha.co.jp/viewer/1030315','mobile-partial-27-files-29-slots'],
 ['MangaPlus-1001834','https://mangaplus.shueisha.co.jp/viewer/1001834','mobile-0-file-reproduction'],
 ['nhentai-visible-2','https://nhentai.net/g/686705/2/','mobile-single-visible-only']
].map(([name,url,proof])=>({name,url,previous:proof,proof}));
const cases = [...pinned,...archivedTargets()].filter((v,i,a) => a.findIndex(x=>x.url===v.url)===i);
const selected = cases.filter(x=>!only.length || only.some(t=>x.name.toLowerCase().includes(t)||new URL(x.url).hostname.includes(t)));
const sleep = ms => new Promise(r=>setTimeout(r,ms));
function publicError(error) {
  const msg = String(error?.message || error || '');
  return msg.replace(/https?:\/\/[^\s"'<>]+/g, '[source-url-redacted]').slice(0,350);
}
function shortAdaptive(a) {
  if (!a) return null;
  return {
    outcome:a.outcome||'', strategy:a.strategy||'', strategySource:a.strategySource||'',
    declaredTotalMatched:a.declaredTotalMatched ?? null, attempts:a.attempts?.length||0,
  };
}
function itemSemantics(item) {
  return {width:item.width||0,height:item.height||0,source:item.source||'',capture:item.capturedVia||'',
    filterCategory:item.filterHints?.category||'',filterChrome:Boolean(item.filterHints?.chrome)};
}
async function launchApp(profile) {
  const env={...process.env,EIW_TEST_USER_DATA:profile};
  delete env.ELECTRON_RUN_AS_NODE;
  const app=await _electron.launch({args:[root,'--eiw-test'],env,timeout:45000});
  const ui=await app.firstWindow();
  await ui.waitForFunction(()=>!!window.eiw,null,{timeout:30000});
  return {app,ui};
}
async function bounded(promise, timeout, label) {
  let timer;
  try {
    return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error(label+'-timeout')),timeout))]);
  } finally {clearTimeout(timer);}
}
async function runCase(ctx, row) {
  const {app,ui}=ctx;
  const started=Date.now(), out={name:row.name,host:new URL(row.url).hostname,
    chapterKey:key(row.url).slice(0,18),archiveEvidence:row.previous,
    archiveProof:row.proof,route:mode,stage:'page-load',state:'not-tested',
    startedAt:new Date().toISOString(),scanned:0,verifiedBytes:0,sampleCount:0};
  try {
    const input={url:row.url,show:false,backend:mode==='electron'?'electron':'chrome',
      chromeControl:mode==='electron'?undefined:mode,
      protectionCompatibility:mode==='standard'};
    const open=await bounded(app.evaluate((_,input)=>global.__eiwTest.openPage(input),input),50000,'page-load');
    out.httpStatus=mode==='electron'?null:(await app.evaluate(()=>global.__eiwTest.chromeInfo())).status||null;
    out.opened=Boolean(open?.url);
    out.gated=Boolean(open?.gated);
    out.finalHost=open?.url && /^https?:/.test(open.url)?new URL(open.url).hostname:null;
    if (out.gated) {out.stage='page-load';out.state='access-gated';return out;}
    out.stage='reader-discovery';
    await sleep(550);
    const scan=await bounded(app.evaluate((_,x)=>global.__eiwTest.scan(x),
      {autoScroll:true,backgrounds:true,canvases:true,waitMs:350,maxSteps:steps}),Math.max(80000,steps*2100),'reader-discovery');
    const items=scan?.items||[];
    out.scanned=items.length;
    out.steps=scan.steps;
    out.truncated=Boolean(scan.truncated);
    out.scanReason=scan.reason || '';
    out.adaptive=shortAdaptive(scan.adaptive);
    out.sources=items.reduce((a,x)=>(a[x.source||'unknown']=(a[x.source||'unknown']||0)+1,a),{});
    out.filterHints=items.reduce((a,x)=>(a[x.filterHints?.category||'unknown']=(a[x.filterHints?.category||'unknown']||0)+1,a),{});
    out.dimensions=items.map(itemSemantics).slice(0,12);
    if (!items.length){out.state='no-reader-evidence';out.stage='reader-discovery';return out;}
    out.stage='gallery-publication';
    await sleep(250);
    const counts=await ui.evaluate(()=>{
      if (typeof all==='undefined'||typeof visibleItems!=='function') return null;
      return {backendReceived:all.length,visible:visibleItems().length};
    }).catch(()=>null);
    out.ui=counts;
    if (counts&&counts.backendReceived!==items.length){out.state='gallery-inconsistent';return out;}
    const ids=[...new Set([0,Math.floor((items.length-1)/2),items.length-1])];
    if(maxSamples>=4){for(let n=0;n<items.length;n+=Math.max(1,Math.floor(items.length/(maxSamples-1))))ids.push(n);}
    const selectedIds=[...new Set(ids)].slice(0,maxSamples);
    out.stage='byte-transfer';
    out.sampleResults=[];
    for(const ordinal of selectedIds){
      const item=items[ordinal];
      try {
        const result=await bounded(app.evaluate(async(_,id)=>{
          const data=await global.__eiwTest.getImage(id);
          const crypto=process.getBuiltinModule('node:crypto');
          const sha256=crypto.createHash('sha256').update(data.buffer).digest('hex');
          let actualDimensions=null;
          try{
            const sharp=process.getBuiltinModule('node:module').createRequire(process.cwd() + '/package.json')('sharp');
            if(sharp){const m=await sharp(data.buffer,{limitInputPixels:100000000}).metadata();actualDimensions=[m.width,m.height];}
          }catch(e){}
          return {bytes:data.buffer.length,sha256,ext:data.ext,decoded:actualDimensions};
        },item.id),30000,'image-byte-transfer');
        out.sampleResults.push({ordinal:ordinal+1,...result,
          metadataDimension:[item.width||0,item.height||0],
          dimensionsMatch:!!result.decoded && result.decoded[0]===item.width && result.decoded[1]===item.height});
        out.verifiedBytes+=result.bytes;
      } catch(error) {out.sampleResults.push({ordinal:ordinal+1,error:publicError(error)});}
    }
    out.sampleCount=out.sampleResults.filter(x=>x.sha256).length;
    if(out.sampleResults.some(x=>x.error)){out.state='byte-failure';return out;}
    if(out.adaptive?.outcome==='empty'){out.stage='reader-discovery';out.state='reader-not-discovered';return out;}
    out.stage='coverage-proof';
    // Sampling and discovery cannot certify a full chapter; do not claim PASS.
    out.state=scan.truncated?'partial-truncated':'sample-verified-coverage-unproven';
    if(out.adaptive?.outcome==='usable' && out.sampleCount===items.length && !scan.truncated)
      out.state='candidate-only-requires-reader-proof';
    return out;
  }catch(error){
    out.error=publicError(error);
    out.state=/timeout/i.test(out.error)?'timed-out':'error';
    try{await bounded(app.evaluate(()=>{global.__eiwTest.cancel();return true;}),4500,'cancel');}catch{}
    return out;
  }finally{out.elapsedMs=Date.now()-started;out.finishedAt=new Date().toISOString();}
}
(async()=>{
  await fs.mkdir(runRoot,{recursive:true});
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const outPath=path.join(runRoot,'live-'+mode+'-'+stamp+'.json');
  const profile=path.join(runRoot,'qa-profile-'+mode+'-'+stamp);
  const results=[];
  const summary={createdAt:new Date().toISOString(),mode,steps,maxSamples,
    historicalSource:'test/live-next-chapter.e2e.cjs',casesInCatalog:cases.length,
    selected:selected.length,neverCompleteFromSamples:true,
    noMobileChanges:true,noProductionProfileChanges:true,
    skippedSites: ['comix.to: no archived exact reader URL', 'hitomi: no archived exact reader URL'],
    results};
  await fs.writeFile(outPath,JSON.stringify(summary,null,2));
  let ctx=null;
  try{
    ctx=await launchApp(profile);
    for(const row of selected){
      console.log('CASE',row.name,new URL(row.url).hostname);
      const result=await runCase(ctx,row);
      results.push(result);
      console.log('RESULT',row.name,result.state,result.stage,'count',result.scanned,'bytes',result.sampleCount);
      await fs.writeFile(outPath,JSON.stringify(summary,null,2));
      if(result.state==='timed-out'){
        await ctx.app.close().catch(()=>{});
        ctx=await launchApp(profile+'-recovery-'+results.length);
      }
    }
  } finally {if(ctx)await ctx.app.close().catch(()=>{});}
  summary.finishedAt=new Date().toISOString();
  summary.counts=results.reduce((a,x)=>(a[x.state]=(a[x.state]||0)+1,a),{});
  await fs.writeFile(outPath,JSON.stringify(summary,null,2));
  console.log('MATRIX',outPath,JSON.stringify(summary.counts));
})().catch(e=>{console.error(publicError(e));process.exitCode=1;});
