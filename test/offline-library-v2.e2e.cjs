'use strict';
const { _electron:electron }=require('playwright-core');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'test-results','offline-library-v2'),profile=path.join(out,'profile');
let app;
(async()=>{
  await fs.rm(out,{recursive:true,force:true});await fs.mkdir(path.join(profile,'harvestts'),{recursive:true});
  const source=path.join(process.env.APPDATA,'ImageHarvest','harvestts','offline-library');
  try{await fs.cp(source,path.join(profile,'harvestts','offline-library'),{recursive:true})}catch{}
  const env={...process.env,EIW_TEST_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
  app=await electron.launch({args:[root,'--eiw-test'],env,timeout:45000});
  const host=await app.firstWindow();await host.waitForFunction(()=>!!window.eiw);
  await host.evaluate(()=>window.eiw.harvestTsLayout({visible:true,bounds:{x:20,y:120,width:1000,height:720}}));
  const created=await host.evaluate(()=>window.eiw.harvestTsCreate({kind:'offline',activate:true}));assert.equal(created.ok,true);
  let id=0;for(let i=0;i<100&&!id;i++){id=await app.evaluate(({webContents})=>webContents.getAllWebContents().find(w=>String(w.getURL()).includes('/offline.html'))?.id||0);if(!id)await new Promise(r=>setTimeout(r,80))}
  assert.ok(id,'offline page missing');
  await app.evaluate(async({webContents},id)=>{const wc=webContents.fromId(id);if(wc.isLoading())await new Promise(r=>wc.once('did-stop-loading',r));},id);
  await new Promise(r=>setTimeout(r,800));
  let state=await app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript(`({cards:document.querySelectorAll('.project-card').length,titles:[...document.querySelectorAll('.project-title')].map(x=>x.textContent),meta:document.getElementById('meta').textContent})`),id);
  assert.ok(state.cards>=1,'saved chapter was not migrated into a project card');
  await app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript(`document.getElementById('newGroup').click()`),id);
  let dialog=await app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript(`({open:document.getElementById('textDialog').open,title:document.getElementById('textDialogTitle').textContent})`),id);assert.equal(dialog.open,true);assert.equal(dialog.title,'สร้างกลุ่ม');
  await app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript(`document.getElementById('textDialogInput').value='ทดสอบกลุ่ม';document.getElementById('textDialogForm').requestSubmit()`),id);await new Promise(r=>setTimeout(r,180));
  let data=await app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript('window.harvestInternal.offlineList()'),id),group=data.groups.find(x=>x.title==='ทดสอบกลุ่ม');assert.ok(group?.id);
  await app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript(`document.getElementById('newProject').click()`),id);dialog=await app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript(`({open:document.getElementById('textDialog').open,title:document.getElementById('textDialogTitle').textContent})`),id);assert.equal(dialog.open,true);assert.equal(dialog.title,'สร้างโปรเจกต์');
  await app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript(`document.getElementById('textDialogInput').value='โปรเจกต์จากปุ่ม';document.getElementById('textDialogForm').requestSubmit()`),id);await new Promise(r=>setTimeout(r,180));
  data=await app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript('window.harvestInternal.offlineList()'),id);assert.ok(data.projects.some(x=>x.title==='โปรเจกต์จากปุ่ม'));
  await app.evaluate(({webContents},arg)=>webContents.fromId(arg.id).executeJavaScript(`window.harvestInternal.offlineGroupRemove(${JSON.stringify(arg.group)})`),{id,group:group.id});
  console.log('PASS: Offline Library create buttons open in-app dialogs and create items',state);
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{try{await app?.close()}catch{}});
