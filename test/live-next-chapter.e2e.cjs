'use strict';
const { _electron } = require('playwright-core');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'test-results', `live-next-${Date.now()}`);
const targets = [
  ['Nekopost-latest','https://www.nekopost.net/manga/17675/9.5'],
  ['Nekopost-9','https://www.nekopost.net/manga/17675/9'],
  ['MangaDex','https://mangadex.org/chapter/372212d6-c478-4391-b48c-a737dd33f9e5/1'],
  ['Readtoon','https://readtoon.com/content/rebirthmonarchofthedead/9'],
  ['Pengi','https://pengi.co/read/c281fb21e4f5d10614f5160fbffa157e'],
  ['NTRNaja-96','https://ntrnaja.com/manga/m-owm0vud5/?chapter=-96'],
  ['NTRNaja-0','https://ntrnaja.com/manga/m-zerh6ddw/?chapter=%E0%B8%95%E0%B8%AD%E0%B8%99%E0%B8%97%E0%B8%B5%E0%B9%88-0'],
  ['CCharem','https://ccharem.cileclo.com/read/little-sister/1.1'],
  ['Manga168','https://manga168x.com/manga/full-time-awakening/chapter/ch-37'],
  ['NiceOppai','https://www.niceoppai.net/Stuck-in-the-Tower/22/'],
  ['MangaIsekaiThai','https://www.mangaisekaithai.net/manga/jakuten-zero-kyuuketsuki-no-ryouchi-kaikaku/%E0%B8%95%E0%B8%AD%E0%B8%99%E0%B8%97%E0%B8%B5%E0%B9%88-6-3/'],
  ['Tanuki','https://www.tanuki-manga.net/shinjiteita-nakama-tachi-ni-dungeon-okuchi-de-korosare-kaketa-ga-gift-%E3%80%8Emugen-gacha%E3%80%8F-de-level-9999-no-nakama-tachi-wo-te-ni-irete-moto-party-member-to-sekai-ni-fukushu-%E3%80%8Ezama-a-1/'],
  ['MangaNeko','https://manga-neko.com/ore-no-genjitsu-wa-renai-game-ka-to-omottara-inochigake-no-game-datta-%e0%b8%95%e0%b8%ad%e0%b8%99%e0%b8%97%e0%b8%b5%e0%b9%88-1/'],
  ['GoManga','https://www.go-manga.com/bad-born-blood-%e0%b8%95%e0%b8%ad%e0%b8%99%e0%b8%97%e0%b8%b5%e0%b9%88-33/'],
  ['DarkManga','https://www.dark-manga.com/archmage-curriculum-%E0%B8%95%E0%B8%AD%E0%B8%99%E0%B8%97%E0%B8%B5%E0%B9%88-12/'],
  ['ZenManga','https://www.zen-manga.com/the-hole-diary-%E0%B9%80%E0%B8%A1%E0%B8%B5%E0%B8%A2%E0%B8%99%E0%B8%B2%E0%B8%A2-%E0%B8%89%E0%B8%B1%E0%B8%99%E0%B8%82%E0%B8%AD%E0%B9%84%E0%B8%94%E0%B9%89%E0%B8%A1%E0%B8%B1%E0%B9%89%E0%B8%A2-36/'],
  ['Oremanga','https://www.oremanga.net/versus/versus-33-2/'],
  ['UpManga','https://www.up-manga.com/one-piece-%E0%B8%95%E0%B8%AD%E0%B8%99%E0%B8%97%E0%B8%B5%E0%B9%88-1188/'],
  ['BlackManga','https://www.black-manga.com/i-was-thrown-into-an-unfamiliar-manga-%E0%B8%95%E0%B8%AD%E0%B8%99%E0%B8%97%E0%B8%B5%E0%B9%88-37/'],
  ['1668Manga','https://1668manga.com/tale-of-a-scribe-who-retires-to-the-countryside-%E0%B8%95%E0%B8%AD%E0%B8%99%E0%B8%97%E0%B8%B5%E0%B9%88-163/'],
  ['MurimManga','https://murim-manga.com/youngest-son-of-the-namgung-clan%E0%B8%95%E0%B8%AD%E0%B8%99%E0%B8%97%E0%B8%B5%E0%B9%88-10/'],
  ['SpeedManga','https://speed-manga.org/god-of-martial-arts-%E0%B8%95%E0%B8%AD%E0%B8%99%E0%B8%97%E0%B8%B5%E0%B9%88-10/'],
  ['PedManga','https://ped-manga.com/reborn-as-the-enemy-prince-%E0%B8%95%E0%B8%AD%E0%B8%99%E0%B8%97%E0%B8%B5%E0%B9%88-10/'],
  ['Paomanga','https://paomanga.com/the-novels-extra-%E0%B8%95%E0%B8%AD%E0%B8%99%E0%B8%97%E0%B8%B5%E0%B9%88-69/'],
  ['FrankManga-latest','https://frank-manga.com/player-who-returned-th/chapter-154'],
  ['FrankManga-153','https://frank-manga.com/player-who-returned-th/chapter-153'],
  ['BullyManga','https://bully-manga.com/constellations-my-disciples-ep0010'],
  ['MangaLC','https://manga-lc.net/manga/kyou-mo-veranda-de/%E0%B8%8B%E0%B8%B5%E0%B8%8B%E0%B8%B1%E0%B9%88%E0%B8%99-1/%E0%B8%95%E0%B8%AD%E0%B8%99%E0%B8%97%E0%B8%B5%E0%B9%88-10/'],
  ['MangaZaa','https://manga-zaa.net/whats-wrong-with-you-duke-10/'],
  ['SnapManga','https://www.snap-manga.com/manga/i-obtained-a-mythic-item/%E0%B8%95%E0%B8%AD%E0%B8%99%E0%B8%97%E0%B8%B5%E0%B9%88-1/'],
  ['Tanuki-9.1','https://www.tanuki-manga.net/shinjiteita-nakama-tachi-ni-dungeon-okuchi-de-korosare-kaketa-ga-gift-%E3%80%8Emugen-gacha%E3%80%8F-de-level-9999-no-nakama-tachi-wo-te-ni-irete-moto-party-member-to-sekai-ni-fukushu-%E3%80%8Ezama-a/']
];
let app, page;
async function ipc(method, args) {
  const result = await page.evaluate(async ({method,args}) => window.eiw[method](args), {method,args});
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
async function attempt(name, url, control) {
  const row = { name, input:url, control, opened:false, scan:false, scanCount:0, next:false };
  try {
    const opened = await ipc('open', { url, show:false, backend:'chrome', chromeControl:control,
      protectionCompatibility:control === 'standard' });
    Object.assign(row, { opened:true, finalUrl:opened.url, title:opened.title, gated:Boolean(opened.gated),
      networkFallback:opened.networkFallback || '' });
    if (opened.gated) return row;
    await page.waitForTimeout(1200);
    try {
      const deepScan = /Tanuki|Manga168/i.test(name);
      const scan = await ipc('scan', { autoScroll:deepScan, backgrounds:false, canvases:true, waitMs:500, maxSteps:deepScan ? 60 : 5 });
      row.scan = true; row.scanCount = scan.items?.length || 0; row.scanTitle = scan.title || '';
      row.scanNotice = scan.notice || ''; row.scanReason = scan.reason || '';
      if (deepScan) await page.waitForTimeout(2500);
    } catch (error) { row.scanError = error.message; }
    try {
      const next = await ipc('nextChapter');
      row.next = Boolean(next.url || next.action === 'click'); row.nextUrl = next.url || ''; row.nextAction = next.action || ''; row.nextText = next.text || '';
      row.confidence = next.confidence || 0; row.nextReason = next.reason || '';
      row.rejected = next.bestRejected || null;
      if (!row.next && next.debug) row.debug = next.debug;
      if (row.next) {
        try {
          const verified = row.nextAction === 'click'
            ? await ipc('advanceNextChapter')
            : await ipc('open', { url:row.nextUrl, show:false, backend:'chrome', chromeControl:control,
                protectionCompatibility:control === 'standard' });
          row.nextVerified = Boolean(verified.url && !verified.gated);
          row.nextFinalUrl = verified.url || ''; row.nextTitle = verified.title || ''; row.nextGated = Boolean(verified.gated);
        } catch (error) { row.nextVerified = false; row.nextVerifyError = error.message; }
      }
    } catch (error) { row.nextError = error.message; }
  } catch (error) { row.openError = error.message; }
  return row;
}
(async () => {
  await fs.mkdir(out, {recursive:true});
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({args:[root,'--eiw-test'], env, timeout:45000});
  page = await app.firstWindow(); await page.waitForFunction(() => !!window.eiw);
  const results = [], only = String(process.argv[2] || '').toLowerCase();
  const runTargets = only === 'extra' ? targets.slice(14) :
    (only ? targets.filter(([name]) => name.toLowerCase().includes(only)) : targets);
  for (const [name,url] of runTargets) {
    console.log('\nTEST', name, url);
    let best = await attempt(name,url,'minimal');
    console.log(' minimal', JSON.stringify(best));
    if (!best.opened || best.gated || !best.next) {
      const standard = await attempt(name,url,'standard');
      console.log(' standard', JSON.stringify(standard));
      if ((!best.opened && standard.opened) || (standard.next && !best.next) ||
          (best.gated && !standard.gated) || (standard.scanCount > best.scanCount)) best = standard;
      best.attempts = [best.control === 'minimal' ? 'minimal' : 'standard', 'standard'];
    } else best.attempts = ['minimal'];
    results.push(best);
    await fs.writeFile(path.join(out,'progress.json'),JSON.stringify(results,null,2));
  }
  await fs.writeFile(path.join(out,'results.json'),JSON.stringify({createdAt:new Date().toISOString(),results},null,2));
  console.log('\nRESULT_PATH', path.join(out,'results.json'));
  console.log('SUMMARY', JSON.stringify(results.map(x=>({name:x.name,opened:x.opened,gated:x.gated,
    scan:x.scan,scanCount:x.scanCount,next:x.next,nextUrl:x.nextUrl,control:x.control,error:x.openError||x.nextError||x.scanError||''}))));
})().catch(async error => {
  console.error(error.stack || error); process.exitCode = 1;
}).finally(async () => { if (app) await app.close().catch(()=>{}); });
