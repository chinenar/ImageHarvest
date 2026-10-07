'use strict';
const {createHash,randomUUID}=require('node:crypto');
const {chooseTextModel}=require('./harvest-translate.cjs');
const {contentRole,translationEligible}=require('./ocr-content-role.cjs');
const LANGUAGES={th:'Thai',en:'English',ja:'Japanese',fr:'French',ko:'Korean',zh:'Chinese'};
function checkSignal(signal){if(signal?.aborted)throw new Error('ยกเลิกการแปลแล้ว');}
function translationText(region,sourceLanguage='auto') {
  const text=String(region.text||'').trim();
  const japanese=sourceLanguage==='ja'||(sourceLanguage==='auto'&&/[\u3040-\u30ff]/u.test(text));
  return text.replace(/\s*\r?\n\s*/g,japanese?'':' ').trim();
}
function validateRegions(regions,{width,height}={}) {
  if(!Array.isArray(regions)||regions.length>2000)throw Error('จำนวนกรอบแปลไม่ถูกต้อง');
  const ids=new Set();
  return regions.map(r=>{
    if(!r||typeof r.id!=='string'||!r.id||r.id.length>200||ids.has(r.id))throw Error('ID กรอบซ้ำหรือไม่ถูกต้อง');
    ids.add(r.id);
    if(typeof r.text!=='string'||r.text.length>4000)throw Error('ข้อความกรอบยาวเกิน 4,000 ตัวอักษร');
    if(width!=null){const b=r.bbox;if(!b||![b.x0,b.y0,b.x1,b.y1].every(Number.isFinite)||b.x0<0||b.y0<0||b.x1>width||b.y1>height||b.x1<=b.x0||b.y1<=b.y0)throw Error('กรอบแปลต้องอยู่ภายในภาพ');}
    return structuredClone(r);
  }).filter(r=>r.text.trim());
}
function validateReply(reply,request) {
  if(!Array.isArray(reply))throw Error('ผู้ให้บริการส่งผลแปลผิดรูปแบบ');
  const ids=new Set(request.map(r=>r.id)),seen=new Set(),results=new Map();
  for(const item of reply){
    const id=String(item?.id??'');
    if(!ids.has(id)||seen.has(id))throw Error('ผู้ให้บริการส่ง ID กรอบผิดหรือซ้ำ');
    seen.add(id);
    if(typeof item.translation==='string'&&item.translation.trim()&&item.translation.length<=20000)results.set(id,{...item,translation:item.translation.trim()});
    else if(typeof item.error==='string'&&item.error)results.set(id,{id,translation:'',error:item.error.slice(0,1000),providerFailure:true});
  }
  return results;
}
function inferredSourceLanguage(text){
  const value=String(text||'');
  if(/\p{Script=Thai}/u.test(value))return 'th';
  if(/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value))return 'ja';
  if(/\p{Script=Hangul}/u.test(value))return 'ko';
  if(/\p{Script=Han}/u.test(value))return 'zh';
  if(/[A-Za-zÀ-ÿ]/u.test(value))return 'en';
  return '';
}
function translationLanguageIssue(text,targetLanguage,sourceText=''){
  let translated=String(text||'').toLowerCase();
  if(sourceText){
    const tokens=String(sourceText).match(/(?:https?:\/\/)?(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,24}(?:\/[A-Za-z0-9_./?=&%#-]*)?|\b[A-Za-z][A-Za-z0-9_-]*\d[A-Za-z0-9_-]*\b|\b[A-Z][a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z]{2,}(?:-[A-Z]{2,})+\b/g)||[];
    for(const token of [...new Set(tokens)].sort((a,b)=>b.length-a.length))translated=translated.split(token.toLowerCase()).join('');
  }
  const letters=translated.match(/\p{L}/gu)||[];
  if(letters.length<2)return '';
  const script={th:/\p{Script=Thai}/u,en:/\p{Script=Latin}/u,fr:/\p{Script=Latin}/u,ja:/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,zh:/\p{Script=Han}/u,ko:/\p{Script=Hangul}/u}[targetLanguage];
  return script&&letters.filter(ch=>script.test(ch)).length/letters.length<.5?'คำแปลยังไม่เป็นภาษา '+LANGUAGES[targetLanguage]:'';
}
class OcrTranslationService {
  constructor({google,ai}){this.google=google;this.ai=ai;}
  async models(){const rows=await this.ai.listModels();const models=rows.map(r=>r.id).filter(id=>{try{return chooseTextModel([id])===id;}catch{return false;}});return {models,preferred:chooseTextModel(models)};}
  async translate(regions,{provider='google',sourceLanguage='auto',targetLanguage='th',model='',context='',imageDigest='',signal,onProgress,includeUncertain=false}={}) {
    if(!['google','ai'].includes(provider)||!LANGUAGES[targetLanguage]||(sourceLanguage!=='auto'&&!LANGUAGES[sourceLanguage]))throw Error('ผู้ให้บริการหรือภาษาแปลไม่ถูกต้อง');
    if(typeof model!=='string'||model.length>200)throw Error('ชื่อโมเดลไม่ถูกต้อง');
    const validated=validateRegions(regions),source=validated.filter(r=>translationEligible(r,{includeUncertain})),skipped=validated.filter(r=>!translationEligible(r,{includeUncertain})).map(r=>({id:r.id,...contentRole(r)})),started=Date.now(),createdAt=new Date().toISOString(),runId=randomUUID();
    checkSignal(signal);
    const selectedModel=provider==='ai'&&source.length?(model||(await this.ai.probe()).model):'';
    checkSignal(signal);
    const maxBatch=provider==='ai'?42:20,maxChars=provider==='ai'?9000:6000;
    const batches=[];let batch=[],chars=0;
    for(const r of source){if(batch.length&&(batch.length>=maxBatch||chars+r.text.length>maxChars)){batches.push(batch);batch=[];chars=0;}batch.push(r);chars+=r.text.length;}if(batch.length)batches.push(batch);
    const output=[];let done=0;
    const request=async(list,effectiveSourceLanguage=sourceLanguage)=>{
      checkSignal(signal);
      const payload=list.map(r=>({id:r.id,text:translationText(r,effectiveSourceLanguage),kind:r.kind||'dialogue',orientation:r.orientation||'horizontal'}));
      let reply;try{reply=provider==='google'?await this.google.translate(payload,{sourceLanguage:effectiveSourceLanguage,targetLanguage,signal}):await this.ai.translateRegions(payload,{model:selectedModel,context,targetLanguage:LANGUAGES[targetLanguage],signal});}
      catch(error){checkSignal(signal);error.providerTransportFailure=true;throw error;}
      checkSignal(signal);return validateReply(reply,list);
    };
    for(const list of batches){
      let byId,batchError=null;
      try{byId=await request(list);}catch(error){checkSignal(signal);if(!error.providerTransportFailure)throw error;batchError=error;byId=new Map();}
      for(const r of list){
        const candidate=byId.get(r.id);
        let result=candidate?.translation?candidate:null,error=candidate?.error||batchError?.message||'',rejectedTranslation='',transportFailure=Boolean(batchError||candidate?.providerFailure);
        if(!batchError&&!candidate?.providerFailure&&(!result||translationLanguageIssue(result.translation,targetLanguage,r.text))){
          rejectedTranslation=result?.translation||'';
          try{result=(await request([r])).get(r.id);}catch(e){checkSignal(signal);error=e.message;transportFailure=Boolean(e.providerTransportFailure);result=null;}
        }
        if(result){const issue=translationLanguageIssue(result.translation,targetLanguage,r.text);if(issue){error=issue;rejectedTranslation=result.translation;result=null;transportFailure=false;}}
        // Auto-detect can occasionally leave a badly OCR'd Latin line mostly
        // untranslated. One final retry with an inferred source script gives
        // Google a deterministic direction without changing the user's saved
        // source-language setting or cache identity.
        let effectiveSourceLanguage=sourceLanguage;
        if(!result&&provider==='google'&&sourceLanguage==='auto'&&!batchError&&!candidate?.providerFailure){
          const inferred=inferredSourceLanguage(r.text);
          if(inferred&&inferred!==targetLanguage){
            try{
              const explicit=(await request([r],inferred)).get(r.id);
              const issue=explicit?.translation?translationLanguageIssue(explicit.translation,targetLanguage,r.text):'';
              if(explicit?.translation&&!issue){result=explicit;effectiveSourceLanguage=inferred;}
              else if(explicit?.translation){error=issue;rejectedTranslation=explicit.translation;}
            }catch(e){checkSignal(signal);error=e.message||error;transportFailure=Boolean(e.providerTransportFailure);}
          }
        }
        output.push({id:r.id,translation:result?.translation||'',status:result?'translated':'failed',error:result?'':error||'ผู้ให้บริการไม่ส่งคำแปลของกรอบนี้',
          sourceText:r.text,sourceTextDigest:createHash('sha256').update(r.text).digest('hex'),bbox:r.bbox?{...r.bbox}:undefined,orientation:r.orientation||'horizontal',
          sourceReviewRequired:Boolean(r.reviewRequired&&!r.reviewed),provider,model:selectedModel,sourceLanguage,effectiveSourceLanguage,targetLanguage,imageDigest,createdAt,runId,
          detectedSourceLanguage:result?.detectedSourceLanguage||'',rejectedTranslation,providerTransportFailure:Boolean(!result&&transportFailure)});
      }
      done+=list.length;onProgress?.({done,total:source.length,provider});
    }
    return {runId,provider,model:selectedModel,sourceLanguage,targetLanguage,imageDigest,createdAt,ms:Date.now()-started,total:source.length,translated:output.filter(r=>r.status==='translated').length,failed:output.filter(r=>r.status==='failed').length,transportFailures:output.filter(r=>r.providerTransportFailure).length,skipped,items:output};
  }
}
module.exports={OcrTranslationService,translationText,validateRegions,validateReply,translationLanguageIssue};
