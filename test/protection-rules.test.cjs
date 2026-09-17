'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process'),vm=require('node:vm');
const {inspectScript,patchScript,RULES,MAX_SCRIPT,modifiedHeaders,sha256}=require('../src/protection-rules.cjs');
const {ProtectionCompatibility,SCRIPT_COUNT,publicURL}=require('../src/protection-compatibility.cjs');
const {compatibilitySettings}=require('../src/compatibility-settings.cjs');
const archives=[['disable-devtool-0.3.9-umd','network-audit-1789671945972/d985a728438df1b3.js'],['devtools-detect-modified-2.1-esm','network-audit-1789671945972/b3e99ed40eccba32.js'],['reviewed-reader-guard-build-1','pengi-comparison-20260918/pengi-asset-9.js']];
const resolveArchive=name=>path.join(__dirname,'../test-results',name);
function fakeCDP(bytes){return{calls:[],async send(method,args){this.calls.push([method,args]);return method==='Fetch.getResponseBody'?{body:bytes.toString('base64'),base64Encoded:true}:{};}};}
const event=(url='https://new-host.example/assets/anything?secret=hidden',status=200)=>({requestId:'id',request:{url},responseStatusCode:status,responseHeaders:[{name:'Content-Type',value:'text/javascript'}]});
test('settings migrate old toggle, default to Chrome and preserve explicit new choices',()=>{
  assert.deepEqual(compatibilitySettings(),{protectionCompatibility:true,browserMode:'chrome'});
  assert.equal(compatibilitySettings({siteCompatibility:false}).protectionCompatibility,true);
  assert.deepEqual(compatibilitySettings({protectionCompatibility:false,browserMode:'electron'}),{protectionCompatibility:false,browserMode:'electron'});
});
test('recognition API accepts bytes only, not hostname or filename',()=>{
  assert.throws(()=>inspectScript('not bytes'),/bytes/);assert.equal(inspectScript(Buffer.from('export const ok=true')).kind,'unrelated');
  assert.equal(RULES.length,3);assert.ok(RULES.every(r=>/^[a-f0-9]{64}$/.test(r.hash)));
});
test('library names are hints only and cannot authorize arbitrary modifications',()=>{
  const bytes=Buffer.from('const documentation="DisableDevtool devtoolschange DevtoolsDetector";window.normal=true;');
  assert.equal(inspectScript(bytes).kind,'unknown');assert.throws(()=>patchScript(bytes),/ไม่แก้สคริปต์/);
});
test('unknown memory-exhaustion pattern is refused, not executed or guessed-patched',async()=>{
  const bytes=Buffer.from('/* window.startBoom new Array(5e6) for(;;) */');assert.equal(inspectScript(bytes).kind,'unsafe-unknown');
  const cdp=fakeCDP(bytes),engine=new ProtectionCompatibility(true,null,cdp);await engine.paused(event());
  assert.equal(cdp.calls.at(-1)[0],'Fetch.failRequest');assert.ok(engine.error);assert.equal(cdp.calls.some(([m])=>m==='Fetch.fulfillRequest'),false);
});
test('unknown scripts pass through unchanged with redacted diagnostics',async()=>{
  const cdp=fakeCDP(Buffer.from('window.devtoolschange=1;')),engine=new ProtectionCompatibility(true,null,cdp);await engine.paused(event());
  assert.equal(cdp.calls.at(-1)[0],'Fetch.continueRequest');assert.equal(engine.unknown,1);assert.equal(engine.applied,0);assert.ok(!JSON.stringify(engine.info()).includes('secret='));
});
test('403, 429, redirects and non-HTTP scripts are not changed or read',async()=>{
  for(const e of [event(undefined,403),event(undefined,429),event(undefined,302),event('blob:https://example.com/a')]){
    const cdp=fakeCDP(Buffer.from('DisableDevtool'));await new ProtectionCompatibility(true,null,cdp).paused(e);assert.deepEqual(cdp.calls.map(x=>x[0]),['Fetch.continueRequest']);
  }
});
test('disabled engine never requests script bodies',async()=>{
  const cdp=fakeCDP(Buffer.from('DisableDevtool'));await new ProtectionCompatibility(false,null,cdp).paused(event());assert.deepEqual(cdp.calls.map(x=>x[0]),['Fetch.continueRequest']);
});
test('analysis respects size and per-document count budgets',async()=>{
  assert.equal(inspectScript(Buffer.alloc(MAX_SCRIPT+1)).kind,'size-limit');
  const cdp=fakeCDP(Buffer.from('x')),engine=new ProtectionCompatibility(true,null,cdp);engine.inspected=SCRIPT_COUNT;await engine.paused(event());assert.equal(engine.skipped,1);assert.equal(cdp.calls.length,1);
  engine.reset();const large=event();large.responseHeaders.push({name:'Content-Length',value:String(MAX_SCRIPT+1)});await engine.paused(large);assert.equal(engine.skipped,1);assert.equal(cdp.calls.length,2);
});
test('modified responses retain security headers and cookies; fix representation metadata',()=>{
  const h=modifiedHeaders([{name:'Content-Encoding',value:'br'},{name:'ETag',value:'old'},{name:'Content-Security-Policy',value:"default-src 'self'"},{name:'Access-Control-Allow-Origin',value:'https://example.com'},{name:'Set-Cookie',value:'test=yes'}],100);
  assert.equal(h.find(x=>x.name==='Content-Length').value,'100');assert.ok(h.some(x=>x.name==='Content-Security-Policy'));assert.ok(h.some(x=>x.name==='Set-Cookie'));assert.equal(h.some(x=>x.name==='ETag'||x.name==='Content-Encoding'),false);
  assert.equal(publicURL('https://u:p@example.com/a?token=secret#key'),'https://example.com/a');
});
for(const [id,file] of archives)test(`reviewed content: ${id} is URL-independent, transformed and syntax checked`,{skip:!fs.existsSync(resolveArchive(file))},async()=>{
  const bytes=fs.readFileSync(resolveArchive(file)),rule=RULES.find(r=>r.id===id);assert.equal(sha256(bytes),rule.hash);assert.equal(inspectScript(bytes).rule.id,id);
  const patched=patchScript(bytes);assert.notEqual(sha256(patched.body),rule.hash);
  const parsed=spawnSync(process.execPath,['--input-type=module','--check'],{input:patched.body,encoding:'utf8'});assert.equal(parsed.status,0,(parsed.stderr||'').slice(-500));
  for(const url of ['https://first.example/renamed.js','http://second.test:8080/blob-like?version=2']){
    const cdp=fakeCDP(bytes),engine=new ProtectionCompatibility(true,null,cdp);await engine.paused(event(url));assert.equal(engine.applied,1);assert.equal(cdp.calls.at(-1)[0],'Fetch.fulfillRequest');assert.equal(cdp.calls.at(-1)[1].body,patched.body.toString('base64'));
  }
  const modified=Buffer.concat([bytes,Buffer.from('\n// a changed build')]);assert.notEqual(inspectScript(modified).kind,'known');assert.throws(()=>patchScript(modified));
  if(id.startsWith('disable-devtool')){
    const sandbox={};vm.runInNewContext(patched.body.toString(),sandbox,{timeout:1000});const api=sandbox.DisableDevtool;
    assert.equal(api.version,'0.3.9');assert.equal(typeof api.md5,'function');assert.equal(api().success,true);assert.equal(api.isRunning,false);
  }
});
