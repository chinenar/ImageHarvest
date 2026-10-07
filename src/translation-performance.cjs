'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const VERSION = 1;
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || min));
const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const ewma = (previous, next, alpha = .32) => previous > 0 ? previous * (1 - alpha) + next * alpha : next;

function translationMachineKey({ platform='', arch='', cpu='', memoryBytes=0, gpu=[] } = {}) {
  const normalized = {
    platform:String(platform || ''),
    arch:String(arch || ''),
    cpu:String(cpu || '').trim(),
    memoryGiB:Math.round(finite(memoryBytes) / (1024 ** 3)),
    gpu:(Array.isArray(gpu) ? gpu : []).map(row => ({
      vendorId:String(row?.vendorId ?? ''),
      deviceId:String(row?.deviceId ?? ''),
      driverVendor:String(row?.driverVendor ?? ''),
      driverVersion:String(row?.driverVersion ?? '')
    })).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 24);
}

function translationProfileKey({ machineKey='', model='', quantization='', contextLength=0 } = {}) {
  return createHash('sha256').update(JSON.stringify({
    machineKey:String(machineKey || ''),
    model:String(model || ''),
    quantization:String(quantization || ''),
    contextLength:Math.max(0, Math.round(finite(contextLength)))
  })).digest('hex').slice(0, 28);
}

function defaultTranslationProfile({ batchPages=2 } = {}) {
  return {
    version:VERSION,
    recommendedParallel:1,
    batchPages:clamp(batchPages, 1, 4),
    levels:{},
    rejectedUntil:{},
    successStreak:0,
    transportFailureStreak:0,
    updatedAt:0
  };
}

function normalizeProfile(input, defaults={}) {
  const base=defaultTranslationProfile(defaults), row=input && typeof input==='object' ? input : {};
  return {
    ...base,
    ...row,
    version:VERSION,
    recommendedParallel:clamp(row.recommendedParallel || base.recommendedParallel,1,4),
    batchPages:clamp(row.batchPages || base.batchPages,1,4),
    levels:row.levels && typeof row.levels==='object' ? structuredClone(row.levels) : {},
    rejectedUntil:row.rejectedUntil && typeof row.rejectedUntil==='object' ? {...row.rejectedUntil} : {}
  };
}

function summarizeProviderMetrics(metrics=[]) {
  const rows=(Array.isArray(metrics)?metrics:[]).filter(Boolean);
  if(!rows.length)return {tps:0,ttftMs:0,providerWallMs:0};
  const positive=(key)=>rows.map(r=>finite(r?.[key])).filter(v=>v>0);
  const avg=list=>list.length?list.reduce((a,b)=>a+b,0)/list.length:0;
  return {tps:avg(positive('tokensPerSecond')),ttftMs:avg(positive('ttftMs')),providerWallMs:avg(positive('wallMs'))};
}

function recordTranslationWave(profile, sample, { maxParallel=4, now=Date.now() } = {}) {
  const next=normalizeProfile(profile,{batchPages:sample?.batchPages||2});
  const parallel=clamp(sample?.parallel||1,1,Math.max(1,maxParallel));
  const regions=Math.max(0,finite(sample?.regions));
  const translated=Math.max(0,finite(sample?.translated));
  const failed=Math.max(0,finite(sample?.failed));
  const transportFailures=Math.max(0,finite(sample?.transportFailures));
  const wallMs=Math.max(1,finite(sample?.wallMs)||1);
  const throughput=translated / (wallMs / 1000);
  const metrics=summarizeProviderMetrics(sample?.providerMetrics);
  const key=String(parallel), level=next.levels[key] || {
    waves:0,successes:0,failures:0,transportFailures:0,
    ewmaThroughput:0,ewmaWallMs:0,ewmaTps:0,ewmaTtftMs:0,lastAt:0
  };
  level.waves++;
  level.lastAt=now;
  level.ewmaWallMs=ewma(level.ewmaWallMs,wallMs);
  if(throughput>0)level.ewmaThroughput=ewma(level.ewmaThroughput,throughput);
  if(metrics.tps>0)level.ewmaTps=ewma(level.ewmaTps,metrics.tps);
  if(metrics.ttftMs>0)level.ewmaTtftMs=ewma(level.ewmaTtftMs,metrics.ttftMs);
  if(transportFailures>0){
    level.failures++;level.transportFailures+=transportFailures;
    next.successStreak=0;next.transportFailureStreak++;
    next.recommendedParallel=Math.max(1,parallel-1);
    next.rejectedUntil[key]=now+6*60*60*1000;
    if(parallel===1&&regions>0&&failed>=Math.max(1,regions*.75))next.batchPages=Math.max(1,next.batchPages-1);
  } else if(failed===0&&translated>0) {
    level.successes++;next.successStreak++;next.transportFailureStreak=0;
    if(parallel===1&&next.successStreak>=2&&metrics.tps>=12&&wallMs<90000)next.batchPages=Math.min(4,next.batchPages+1);
    const lower=parallel>1?next.levels[String(parallel-1)]:null;
    if(lower?.ewmaThroughput>0&&level.ewmaThroughput>0){
      const gain=level.ewmaThroughput/lower.ewmaThroughput;
      if(gain>=1.10){
        next.recommendedParallel=Math.max(next.recommendedParallel,parallel);
        delete next.rejectedUntil[key];
      }else if(level.waves>=1){
        next.recommendedParallel=Math.min(next.recommendedParallel,Math.max(1,parallel-1));
        next.rejectedUntil[key]=now+12*60*60*1000;
      }
    }else next.recommendedParallel=Math.max(next.recommendedParallel,parallel);
  } else {
    level.failures++;next.successStreak=0;
  }
  next.levels[key]=level;
  next.recommendedParallel=clamp(next.recommendedParallel,1,Math.max(1,maxParallel));
  next.updatedAt=now;
  return next;
}

function recommendTranslationParallel(profile, {
  currentParallel=1,
  maxParallel=4,
  remainingGroups=0,
  providerMetrics=[],
  wallMs=0,
  now=Date.now()
}={}) {
  const p=normalizeProfile(profile);
  const current=clamp(currentParallel,1,Math.max(1,maxParallel));
  const learned=clamp(p.recommendedParallel||1,1,Math.max(1,maxParallel));
  if(learned<current)return learned;
  if(current>=maxParallel||remainingGroups<2)return current;
  if(finite(p.rejectedUntil?.[String(current+1)])>now)return current;
  const metrics=summarizeProviderMetrics(providerMetrics);
  const level=p.levels[String(current)]||{};
  const tps=metrics.tps||finite(level.ewmaTps);
  const ttft=metrics.ttftMs||finite(level.ewmaTtftMs);
  const observedWall=Math.max(finite(wallMs),finite(level.ewmaWallMs));
  // A slow single request is already saturating the current machine/model.
  // Keep the current level instead of making it four times slower merely
  // because the backend says it supports four contexts.
  if((tps>0&&tps<8)||(ttft>8000)||(observedWall>120000))return current;
  if((level.successes||0)<1)return current;
  return current+1;
}

class TranslationPerformanceStore {
  constructor(file){this.file=file;this.data=null;this.write=Promise.resolve();}
  async load(){
    if(this.data)return this.data;
    try{
      const parsed=JSON.parse(await fs.readFile(this.file,'utf8'));
      this.data={version:VERSION,profiles:parsed?.profiles&&typeof parsed.profiles==='object'?parsed.profiles:{}};
    }catch{this.data={version:VERSION,profiles:{}};}
    return this.data;
  }
  async get(key,defaults={}){
    const data=await this.load();
    return normalizeProfile(data.profiles[key],defaults);
  }
  async set(key,profile){
    const data=await this.load();
    data.profiles[key]=normalizeProfile(profile);
    const payload=JSON.stringify(data,null,2),dir=path.dirname(this.file),tmp=this.file+'.tmp';
    const task=this.write.catch(()=>{}).then(async()=>{await fs.mkdir(dir,{recursive:true});await fs.writeFile(tmp,payload,'utf8');await fs.rename(tmp,this.file).catch(async error=>{if(!['EEXIST','EPERM','EACCES'].includes(error.code))throw error;await fs.rm(this.file,{force:true});await fs.rename(tmp,this.file);});});
    this.write=task.catch(()=>{});
    await task;
    return data.profiles[key];
  }
}

module.exports={
  translationMachineKey,
  translationProfileKey,
  defaultTranslationProfile,
  normalizeProfile,
  summarizeProviderMetrics,
  recordTranslationWave,
  recommendTranslationParallel,
  TranslationPerformanceStore
};
