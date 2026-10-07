'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {CdpTransport}=require('../src/cdp-transport.cjs');
const {ChromeBrowser}=require('../src/chrome-browser.cjs');
function fake(){const c=new CdpTransport(),sent=[];c.ws={readyState:WebSocket.OPEN,send:s=>sent.push(JSON.parse(s)),close(){this.readyState=WebSocket.CLOSED;}};return{c,sent};}
test('CDP refuses non-loopback endpoints and disconnected commands',async()=>{
 await assert.rejects(CdpTransport.connect('ws://example.com/devtools/page/x'),/loopback/);
 await assert.rejects(new CdpTransport().send('Page.enable'),/closed/);
});
test('CDP correlates replies without enabling Runtime notifications',async()=>{
 const {c,sent}=fake();const a=c.send('Page.getFrameTree'),b=c.send('Runtime.evaluate',{expression:'1'});
 c.receive(JSON.stringify({id:sent[1].id,result:{answer:2}}));c.receive(JSON.stringify({id:sent[0].id,result:{answer:1}}));
 assert.deepEqual(await a,{answer:1});assert.deepEqual(await b,{answer:2});assert.equal(c.pending.size,0);
 assert.deepEqual([...c.methods],['Page.getFrameTree','Runtime.evaluate']);c.close();
});
test('CDP forwards protocol events and surfaces protocol errors',async()=>{
 const {c,sent}=fake();let seen;c.on('Page.frameNavigated',v=>{seen=v;});c.receive(JSON.stringify({method:'Page.frameNavigated',params:{frame:{id:'1'}}}));
 assert.equal(seen.frame.id,'1');const p=c.send('Page.navigate');c.receive(JSON.stringify({id:sent[0].id,error:{message:'denied'}}));await assert.rejects(p,/denied/);c.close();
});
test('CDP timeout and disconnect reject pending work, without leaking timers',async()=>{
 const {c}=fake();await assert.rejects(c.send('Page.getFrameTree',{},10),/timeout/);assert.equal(c.pending.size,0);
 const p=c.send('Runtime.evaluate');c.close();await assert.rejects(p,/closed/);assert.equal(c.pending.size,0);
});
test('Switching browser implementation preserves DNS choice, without launching or patching a page',async()=>{
 const browser=new ChromeBrowser();await browser.setNetworkMode('google');await browser.setControlMode('minimal');
 assert.equal(browser.networkMode,'google');assert.equal(browser.compatibilityInfo().scriptsModified,false);assert.equal(browser.compatibilityInfo().applied,0);
 await browser.setControlMode('standard');assert.equal(browser.networkMode,'google');await browser.close();
});
