'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {translationMachineKey,translationProfileKey,defaultTranslationProfile,recordTranslationWave,recommendTranslationParallel,TranslationPerformanceStore}=require('../src/translation-performance.cjs');

test('translation performance key is machine + model + quant + context specific',()=>{
 const machine=translationMachineKey({platform:'win32',arch:'x64',cpu:'CPU X',memoryBytes:32*1024**3,gpu:[{vendorId:1,deviceId:2}]});
 assert.equal(machine,translationMachineKey({platform:'win32',arch:'x64',cpu:'CPU X',memoryBytes:32*1024**3,gpu:[{vendorId:1,deviceId:2}]}));
 assert.notEqual(machine,translationMachineKey({platform:'win32',arch:'x64',cpu:'CPU X',memoryBytes:32*1024**3,gpu:[{vendorId:1,deviceId:3}]}));
 const a=translationProfileKey({machineKey:machine,model:'qwen',quantization:'Q4_K_M',contextLength:8192});
 assert.notEqual(a,translationProfileKey({machineKey:machine,model:'qwen',quantization:'Q5_K_M',contextLength:8192}));
 assert.notEqual(a,translationProfileKey({machineKey:machine,model:'qwen',quantization:'Q4_K_M',contextLength:16384}));
});

test('fresh profile probes upward only after a fast successful real wave',()=>{
 let p=defaultTranslationProfile({batchPages:2});
 p=recordTranslationWave(p,{parallel:1,batchPages:2,regions:20,translated:20,failed:0,transportFailures:0,wallMs:20000,providerMetrics:[{tokensPerSecond:20,ttftMs:1500}]},{maxParallel:4,now:1000});
 assert.equal(recommendTranslationParallel(p,{currentParallel:1,maxParallel:4,remainingGroups:4,providerMetrics:[{tokensPerSecond:20,ttftMs:1500}],wallMs:20000,now:1000}),2);
});

test('slow local model stays at one task even when backend advertises more contexts',()=>{
 let p=defaultTranslationProfile({batchPages:2});
 p=recordTranslationWave(p,{parallel:1,batchPages:2,regions:20,translated:20,failed:0,transportFailures:0,wallMs:90000,providerMetrics:[{tokensPerSecond:6.5,ttftMs:9300}]},{maxParallel:4,now:1000});
 assert.equal(recommendTranslationParallel(p,{currentParallel:1,maxParallel:4,remainingGroups:4,providerMetrics:[{tokensPerSecond:6.5,ttftMs:9300}],wallMs:90000,now:1000}),1);
});

test('parallel level that does not improve throughput is rejected and remembered',()=>{
 let p=defaultTranslationProfile({batchPages:2});
 p=recordTranslationWave(p,{parallel:1,batchPages:2,regions:20,translated:20,failed:0,transportFailures:0,wallMs:20000,providerMetrics:[{tokensPerSecond:20,ttftMs:1200}]},{maxParallel:4,now:1000});
 p=recordTranslationWave(p,{parallel:2,batchPages:2,regions:40,translated:40,failed:0,transportFailures:0,wallMs:39000,providerMetrics:[{tokensPerSecond:10,ttftMs:3000},{tokensPerSecond:10,ttftMs:3000}]},{maxParallel:4,now:2000});
 assert.equal(p.recommendedParallel,1);
 assert.ok(p.rejectedUntil['2']>2000);
});

test('transport failure at parallel one reduces batch size instead of retrying the same load forever',()=>{
 let p=defaultTranslationProfile({batchPages:3});
 p=recordTranslationWave(p,{parallel:1,batchPages:3,regions:30,translated:0,failed:30,transportFailures:30,wallMs:600000},{maxParallel:4,now:1000});
 assert.equal(p.recommendedParallel,1);assert.equal(p.batchPages,2);assert.equal(p.transportFailureStreak,1);
});

test('translation performance store persists learned profile',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ih-perf-')),file=path.join(dir,'perf.json'),store=new TranslationPerformanceStore(file);
 const key='profile';let p=defaultTranslationProfile({batchPages:2});
 p=recordTranslationWave(p,{parallel:1,batchPages:2,regions:10,translated:10,failed:0,wallMs:10000,providerMetrics:[{tokensPerSecond:18,ttftMs:1000}]},{maxParallel:4,now:1234});
 await store.set(key,p);
 const reread=new TranslationPerformanceStore(file),loaded=await reread.get(key,{batchPages:4});
 assert.equal(loaded.batchPages,2);assert.equal(loaded.levels['1'].successes,1);assert.equal(loaded.updatedAt,1234);
 await fs.rm(dir,{recursive:true,force:true});
});
