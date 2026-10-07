'use strict';
const { _electron: electron }=require('playwright-core');
const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'test-results','harvest-session-history'),profile=path.join(out,'profile');
let server,app;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function launch(){
  const env={...process.env,EIW_TEST_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
  const a=await electron.launch({args:[root,'--eiw-test'],env,timeout:45000});
  const page=await a.firstWindow();await page.waitForFunction(()=>!!window.eiw);return {a,page};
}
async function waitGuest(a,prefix,exact){
  for(let i=0;i<120;i++){
    const state=await a.evaluate(({webContents},arg)=>{
      const rows=webContents.getAllWebContents().filter(w=>String(w.getURL()||'').startsWith(arg.prefix));
      const wc=arg.exact?rows.find(w=>w.getURL()===arg.exact):rows[0];
      return wc?{id:wc.id,url:wc.getURL(),back:wc.navigationHistory.canGoBack(),forward:wc.navigationHistory.canGoForward(),len:wc.navigationHistory.length(),index:wc.navigationHistory.getActiveIndex(),zoom:wc.getZoomFactor()}:null;
    },{prefix,exact});
    if(state)return state;await sleep(80);
  }throw Error('guest not ready '+(exact||prefix));
}
(async()=>{
 await fs.rm(out,{recursive:true,force:true});await fs.mkdir(out,{recursive:true});
 server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<title>'+req.url+'</title><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a><h1>'+req.url+'</h1>')});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 let launched=await launch();app=launched.a;let page=launched.page;
 const first=await page.evaluate(()=>window.eiw.harvestTsLayout({visible:true,bounds:{x:20,y:120,width:900,height:650}}));assert.equal(first.ok,true);
 const defaultId=first.data.activeId;
 const created=await page.evaluate(url=>window.eiw.harvestTsCreate({url,activate:true}),base+'/a');assert.equal(created.ok,true);const id=created.data.activeId;
 if(defaultId&&defaultId!==id)await page.evaluate(id=>window.eiw.harvestTsClose({id}),defaultId);
 await waitGuest(app,base,base+'/a');
 for(const url of [base+'/b',base+'/c']){const r=await page.evaluate(({id,url})=>window.eiw.harvestTsNavigate({id,url}),{id,url});assert.equal(r.ok,true);await waitGuest(app,base,url);}
 await page.evaluate(id=>window.eiw.harvestTsAction({id,action:'zoom-reset'}),id);
 let guest=await waitGuest(app,base,base+'/c');
 await app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript("window.dispatchEvent(new WheelEvent('wheel',{ctrlKey:true,deltaY:-120,cancelable:true,bubbles:true}))"),guest.id);
 await sleep(160);guest=await waitGuest(app,base,base+'/c');assert.ok(Math.abs(guest.zoom-1.1)<.01,'Ctrl+wheel actual zoom='+guest.zoom);
 await page.evaluate(id=>window.eiw.harvestTsAction({id,action:'zoom-in'}),id);
 let live=await waitGuest(app,base,base+'/c');assert.ok(live.back);assert.ok(live.len>=3);assert.ok(Math.abs(live.zoom-1.25)<.01);
 const toast=await app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript("document.getElementById('__harvestts_zoom_toast__')?.dataset.percent||''"),live.id);assert.equal(toast,'125');
 await app.close();app=null;await sleep(400);
 const saved=JSON.parse(await fs.readFile(path.join(profile,'harvestts','tabs.json'),'utf8'));assert.equal(saved.version,2);const row=saved.tabs.find(x=>x.url===base+'/c');assert.ok(row);assert.ok(row.history.entries.length>=3);assert.equal(row.history.entries.at(-1).url,base+'/c');assert.ok(Math.abs(row.zoomFactor-1.25)<.01);
 launched=await launch();app=launched.a;page=launched.page;
 const restored=await page.evaluate(()=>window.eiw.harvestTsLayout({visible:true,bounds:{x:20,y:120,width:900,height:650}}));assert.equal(restored.ok,true);const restoredTab=restored.data.tabs.find(x=>x.url===base+'/c');assert.ok(restoredTab);assert.equal(restoredTab.canGoBack,true);assert.ok(restoredTab.historyLength>=3);assert.ok(Math.abs(restoredTab.zoomFactor-1.25)<.01);
 await page.evaluate(id=>window.eiw.harvestTsAction({id,action:'back'}),restoredTab.id);live=await waitGuest(app,base,base+'/b');assert.equal(live.forward,true);assert.equal(live.back,true);
 await page.evaluate(id=>window.eiw.harvestTsAction({id,action:'zoom-reset'}),restoredTab.id);await sleep(100);live=await waitGuest(app,base,base+'/b');assert.ok(Math.abs(live.zoom-1)<.01);
 console.log('PASS: HarvestTS restores per-tab back/forward history and per-tab zoom across relaunches');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{try{await app?.close()}catch{};try{server?.close()}catch{}});
