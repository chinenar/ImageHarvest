'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {
  translationMachineKey,translationProfileKey,defaultTranslationProfile,
  recordTranslationWave,recommendTranslationParallel,TranslationPerformanceStore
}=require('../src/translation-performance.cjs');

test('translation performance profile is scoped to machine model quantization and context',()=>{
  const machineA=translationMachineKey({platform:'win32',arch:'x64',cpu:'CPU A',memoryBytes:64*1024**3,gpu:[{vendorId:'10de',deviceId:'2783'}]});
  const machineB=translationMachineKey({platform:'win32',arch:'x64',cpu:'CPU A',memoryBytes:64*1024**3,gpu:[{vendorId:'10de',deviceId:'2684'}]});
  assert.notEqual(machineA,machineB);
  const a=translationProfileKey({machineKey:machineA,model:'qwen-27b',quantization:'Q4_K_M',contextLength:8192});
  assert.notEqual(a,translationProfileKey({machineKey:machineB,model:'qwen-27b',quantization:'Q4_K_M',contextLength:8192}));
  assert.notEqual(a,translationProfileKey({machineKey:machineA,model:'qwen-27b',quantization:'Q5_K_M',contextLength:8192}));
  assert.notEqual(a,translationProfileKey({machineKey:machineA,model:'qwen-27b',quantization:'Q4_K_M',contextLength:16384}));
});

test('auto tuner explores upward only when the current machine/model is responsive',()=>{
  let p=defaultTranslationProfile({batchPages:2});
  p=recordTranslationWave(p,{parallel:1,batchPages:2,regions:20,translated:20,failed:0,wallMs:24000,providerMetrics:[{tokensPerSecond:18,ttftMs:1800,wallMs:23000}]},{maxParallel:4,now:1000});
  assert.equal(recommendTranslationParallel(p,{currentParallel:1,maxParallel:4,remainingGroups:6,providerMetrics:[{tokensPerSecond:18,ttftMs:1800}],wallMs:24000,now:1001}),2);
  p=recordTranslationWave(p,{parallel:2,batchPages:2,regions:40,translated:40,failed:0,wallMs:26000,providerMetrics:[{tokensPerSecond:17,ttftMs:2200,wallMs:25000}]},{maxParallel:4,now:2000});
  assert.equal(p.recommendedParallel,2);
  assert.equal(recommendTranslationParallel(p,{currentParallel:2,maxParallel:4,remainingGroups:4,providerMetrics:[{tokensPerSecond:17,ttftMs:2200}],wallMs:26000,now:2001}),3);
});

test('slow or failing model stays conservative and remembers rejected concurrency',()=>{
  let p=defaultTranslationProfile({batchPages:2});
  p=recordTranslationWave(p,{parallel:1,batchPages:2,regions:20,translated:20,failed:0,wallMs:180000,providerMetrics:[{tokensPerSecond:6.5,ttftMs:10000,wallMs:179000}]},{maxParallel:4,now:1000});
  assert.equal(recommendTranslationParallel(p,{currentParallel:1,maxParallel:4,remainingGroups:8,providerMetrics:[{tokensPerSecond:6.5,ttftMs:10000}],wallMs:180000,now:1001}),1);
  p=recordTranslationWave(p,{parallel:2,batchPages:2,regions:20,translated:0,failed:20,transportFailures:20,wallMs:300000},{maxParallel:4,now:2000});
  assert.equal(p.recommendedParallel,1);
  assert.ok(p.rejectedUntil['2']>2000);
  assert.equal(recommendTranslationParallel(p,{currentParallel:2,maxParallel:4,remainingGroups:8,now:2001}),1);
});

test('fast single-task runs can grow batch pages while repeated single-task transport failure shrinks them',()=>{
  let p=defaultTranslationProfile({batchPages:2});
  p=recordTranslationWave(p,{parallel:1,batchPages:2,regions:12,translated:12,failed:0,wallMs:30000,providerMetrics:[{tokensPerSecond:18,ttftMs:1500}]},{maxParallel:4,now:1});
  p=recordTranslationWave(p,{parallel:1,batchPages:2,regions:12,translated:12,failed:0,wallMs:28000,providerMetrics:[{tokensPerSecond:19,ttftMs:1400}]},{maxParallel:4,now:2});
  assert.equal(p.batchPages,3);
  p=recordTranslationWave(p,{parallel:1,batchPages:3,regions:12,translated:0,failed:12,transportFailures:12,wallMs:200000},{maxParallel:4,now:3});
  assert.equal(p.batchPages,2);
});

test('performance store persists learned profiles',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ih-translate-perf-'));
  const file=path.join(dir,'performance.json');
  try{
    const store=new TranslationPerformanceStore(file);
    let p=defaultTranslationProfile({batchPages:2});p.recommendedParallel=3;p.updatedAt=123;
    await store.set('abc',p);
    const reopened=new TranslationPerformanceStore(file),loaded=await reopened.get('abc');
    assert.equal(loaded.recommendedParallel,3);assert.equal(loaded.updatedAt,123);assert.equal(loaded.batchPages,2);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
