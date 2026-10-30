'use strict';
const {_electron:electron}=require('playwright-core'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'..'),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const app=await electron.launch({args:[root,'--eiw-test'],env,timeout:45000});
 try{
  const main=await app.firstWindow();await main.waitForFunction(()=>!!window.eiw);
  await main.evaluate(()=>window.eiw.ocrLabOpen());
  let lab;for(let i=0;i<50&&!lab;i++){lab=app.windows().find(p=>p.url().endsWith('/ocr-lab.html'));if(!lab)await new Promise(r=>setTimeout(r,100));}
  assert.ok(lab);await lab.waitForFunction(()=>!!window.ocrLab);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(w=>{w.webContents.setBackgroundThrottling(false);w.hide();}));
  const imported=await app.evaluate(async(_e,files)=>global.__eiwTest.ocrLabAddFiles(files),[path.join(root,'test/fixtures/ocr-thai-bubble.png')]);
  await lab.evaluate(rows=>addPages(rows),imported);await lab.waitForFunction(()=>!document.getElementById('canvas').hidden);
  await lab.evaluate(()=>{current().regions=[{id:'sound',text:'ドン',bbox:{x0:210,y0:180,x1:505,y1:324},kind:'text',translation:'stale',translationRecord:{}}];renderPages();selectRegion('sound',true);});
  await lab.evaluate(()=>{current().regions[0].contentRole={role:'uncertain',reason:'possible-sound-effect-needs-review',excluded:true};renderList();});
  assert.match(await lab.locator('#regions').innerText(),/อาจเป็นเอฟเฟกต์/);
  await lab.locator('#kind').selectOption('sfx');await lab.locator('#apply').click();
  await lab.waitForFunction(()=>current().regions[0].kind==='sfx');
  const result=await lab.evaluate(()=>current().regions[0]);
  assert.equal(result.text,'ドン');assert.equal(result.contentRole.role,'sfx');assert.equal(result.contentRole.excluded,true);assert.equal(result.translation,undefined);assert.equal(result.translationRecord,undefined);
  await lab.locator('#kind').selectOption('bubble');await lab.locator('#apply').click();
  await lab.waitForFunction(()=>current().regions[0].kind==='bubble');
  assert.equal(await lab.evaluate(()=>current().regions[0].contentRole.excluded),false);
  assert.equal(await lab.locator('#showLineBoxes').isChecked(),false);
  await lab.locator('#showLineBoxes').check();
  const geometry=await lab.evaluate(()=>{
   const row=current().regions[0];row.displayGeometry={signature:JSON.stringify([row.text,row.bbox]),boxes:[{x0:210,y0:180,x1:300,y1:210},{x0:320,y0:250,x1:500,y1:280}]};
   const ctx=document.getElementById('canvas').getContext('2d'),original=ctx.strokeRect,drawn=[];
   ctx.strokeRect=function(...args){drawn.push(args.map(n=>n/scale));return original.apply(this,args);};
   try{paint();}finally{ctx.strokeRect=original;}
   return drawn;
  });
  assert.equal(geometry.length,2);assert.deepEqual(geometry.map(a=>a.map(Math.round)),[[210,180,90,30],[320,250,180,30]]);
  await lab.evaluate(()=>{
   const bbox={x0:210,y0:180,x1:280,y1:250};
   current().regions=[{id:'script',text:'5',bbox,kind:'text',reviewRequired:true,
    scriptConflictEvidence:{signature:JSON.stringify(['5',bbox]),text:'ち'},
    contentRole:{role:'uncertain',reason:'script-conflict-needs-review',excluded:true},
    alternatives:[{engine:'manga-ocr',variant:'original',text:'ち',confidence:null}]}];
   renderPages();selectRegion('script',true);
  });
  assert.match(await lab.locator('#regions').innerText(),/คำอ่านต่างภาษาขัดกัน/);
  await lab.locator('#alternatives details').evaluate(el=>{el.open=true;});
  await lab.getByRole('button',{name:'ใช้คำอ่านนี้',exact:true}).click();
  assert.equal(await lab.locator('#text').inputValue(),'ち');
  await lab.locator('#reviewed').check();await lab.locator('#apply').click();
  await lab.waitForFunction(()=>current().regions[0].reviewed&&current().regions[0].text==='ち');
  assert.equal(await lab.evaluate(()=>current().regions[0].contentRole.excluded),false);
  await lab.evaluate(()=>{current().regions[0].contentRole={role:'uncertain',reason:'overlapping-readings-need-review',excluded:true};renderList();});
  assert.match(await lab.locator('#regions').innerText(),/กรอบข้อความทับกัน/);
  await lab.evaluate(()=>{current().regions[0].contentRole={role:'uncertain',reason:'shared-ink-needs-review',excluded:true};renderList();});
  assert.match(await lab.locator('#regions').innerText(),/ขอบเขตหมึกยังแยกไม่ชัด/);
  console.log('PASS: sound-effect classification preserves source, clears stale translation, and can be reversed.');
 }finally{await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
