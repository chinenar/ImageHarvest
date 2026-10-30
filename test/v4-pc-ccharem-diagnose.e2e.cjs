'use strict';
const {_electron}=require('playwright-core');
const path=require('node:path'),os=require('node:os'),fs=require('node:fs/promises');
const root=path.resolve(__dirname,'..'),profile=path.resolve(root,'test-results','v4-pc-regression-20261013','qa-ccharem-diagnostic');
const url='https://ccharem.cileclo.com/read/น้องสาวที่น่ารักคนนี้เป็นของพี่แค่คนเดียว/5?page=1';
(async()=>{
 const env={...process.env,EIW_TEST_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
 const app=await _electron.launch({args:[root,'--eiw-test'],env,timeout:45000});
 try{
 const ui=await app.firstWindow();await ui.waitForFunction(()=>!!window.eiw);
 let opened=await app.evaluate((_,url)=>global.__eiwTest.openPage({url,show:false,backend:'chrome',chromeControl:'minimal'}),url);
 console.log('OPEN',JSON.stringify({url:opened.url,status:opened.httpStatus,title:opened.title,gated:opened.gated}));
 await ui.waitForTimeout(800);
 const data=await app.evaluate(()=>global.__eiwTest.runPage(`(()=>{
 const a=[...document.querySelectorAll('a[href]')].map(x=>x.getAttribute('href')).filter(x=>x&&(/read|manga|chapter|detail/i.test(x))).slice(0,30);
 const imgs=[...document.images].slice(0,10).map(x=>({w:x.naturalWidth,h:x.naturalHeight}));
 const canvas=[...document.querySelectorAll('canvas')].map(x=>({w:x.width,h:x.height})).slice(0,10);
 return {url:location.origin+location.pathname,title:document.title,
  headings:document.querySelectorAll('h1,h2').length, imgCount:document.images.length,
  imgs, canvasCount:document.querySelectorAll('canvas').length,canvas,
  links:a,totalLinks:document.querySelectorAll('a').length,
  readerCandidates:document.querySelectorAll('[class*=reader],[id*=reader],[class*=chapter],[id*=chapter]').length,
  metaRobots:document.querySelector('meta[name=robots]')?.content||''};
})()`));
 console.log('DOM',JSON.stringify(data,null,2));
 }finally{await app.close().catch(()=>{});}
})().catch(e=>{console.error(e?.message||e);process.exitCode=1});
