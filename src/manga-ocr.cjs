'use strict';

const { createWorker, OEM, PSM } = require('tesseract.js');
const path = require('node:path');
const sharp = require('sharp');
const { detectText } = require('./comic-text-detector.cjs');
const { assignIds, fusePasses } = require('./ocr-review.cjs');

function normalizeText(value) {
  return String(value || '')
    .normalize('NFC').replace(/\u0e4d\u0e32/g, '\u0e33')
    .replace(/\r/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function meaningfulScore(text) {
  const value = String(text || '');
  const chars = value.match(/[\p{L}\p{N}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) || [];
  return chars.length;
}

function scriptHint(text) {
  const value = String(text || '');
  if (/\p{Script=Thai}/u.test(value)) return 'th';
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value)) return 'ja';
  if (/\p{Script=Han}/u.test(value)) return 'cjk';
  if (/[À-ÿ]/u.test(value)) return 'latin';
  if (/[A-Za-z]/.test(value)) return 'latin';
  return 'unknown';
}

function regionsFromBlocks(blocks, pageIndex = 0, { orientation = 'horizontal' } = {}) {
  const rows = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    for (const paragraph of Array.isArray(block?.paragraphs) ? block.paragraphs : []) {
      // Split widely separated words and lines inside an OCR paragraph. Never
      // join across paragraphs: close balloons need separate identities.
      const lines = [];
      for (const line of paragraph.lines || []) {
        const words = (line.words || []).filter(w => normalizeText(w.text) && w.bbox);
        const sorted = [...words].sort((a,b) => orientation === 'vertical' ? a.bbox.y0-b.bbox.y0 : a.bbox.x0-b.bbox.x0);
        let group = [];
        const flush = () => {
          if (!group.length) return;
          const box = {x0:Math.min(...group.map(w=>w.bbox.x0)),y0:Math.min(...group.map(w=>w.bbox.y0)),x1:Math.max(...group.map(w=>w.bbox.x1)),y1:Math.max(...group.map(w=>w.bbox.y1))};
          const joined=group.map(w=>w.text).join(orientation==='vertical'||group.some(w=>/[\p{Script=Thai}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(w.text))?'':' ');
          lines.push({text:normalizeText(group.length===words.length&&line.text?line.text:joined),bbox:box,words:group,confidence:group.reduce((n,w)=>n+(Number(w.confidence)||0),0)/group.length});
          group=[];
        };
        for (const word of sorted) {
          const previous = group.at(-1);
          // A tall isolated pipe is often the balloon boundary between two
          // sentences. Keep it for review but prevent it bridging the sentences.
          if(orientation==='horizontal'&&/^[|│]$/.test(word.text)&&previous&&word.bbox.y1-word.bbox.y0>(previous.bbox.y1-previous.bbox.y0)*1.4){
            flush();group.push(word);flush();continue;
          }
          if (previous) {
            const gap = orientation==='vertical' ? word.bbox.y0-previous.bbox.y1 : word.bbox.x0-previous.bbox.x1;
            const size = orientation==='vertical' ? Math.min(word.bbox.x1-word.bbox.x0,previous.bbox.x1-previous.bbox.x0) : Math.min(word.bbox.y1-word.bbox.y0,previous.bbox.y1-previous.bbox.y0);
            if (gap > Math.max(12,size*1.5)) flush();
          }
          group.push(word);
        }
        flush();
        if (!words.length && normalizeText(line.text) && line.bbox) lines.push(line);
      }
      const groups=[];
      for (const line of lines) {
        const b=line.bbox;
        const previous=groups.find(g=>{
          const a=g.at(-1).bbox;
          if(orientation==='vertical') return Math.max(0,Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0))/Math.max(1,Math.min(a.y1-a.y0,b.y1-b.y0))>.45 && Math.abs(a.x0-b.x1)<Math.max(10,(a.x1-a.x0)*1.3);
          return Math.max(0,Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0))/Math.max(1,Math.min(a.x1-a.x0,b.x1-b.x0))>.45 && b.y0-a.y1>=-3 && b.y0-a.y1<Math.max(10,(a.y1-a.y0)*.9);
        });
        if(previous)previous.push(line);else groups.push([line]);
      }
      const units=groups.length ? groups.map(g=>({text:g.map(l=>l.text).join('\n'),confidence:g.reduce((n,l)=>n+(Number(l.confidence)||0),0)/g.length,
        bbox:{x0:Math.min(...g.map(l=>l.bbox.x0)),y0:Math.min(...g.map(l=>l.bbox.y0)),x1:Math.max(...g.map(l=>l.bbox.x1)),y1:Math.max(...g.map(l=>l.bbox.y1))},words:g.flatMap(l=>l.words||[])})) : [paragraph];
      for (const unit of units) {
      const text = normalizeText(unit?.text);
      const bbox = unit?.bbox || {};
      const x0 = Math.max(0, Math.round(Number(bbox.x0) || 0));
      const y0 = Math.max(0, Math.round(Number(bbox.y0) || 0));
      const x1 = Math.max(x0, Math.round(Number(bbox.x1) || x0));
      const y1 = Math.max(y0, Math.round(Number(bbox.y1) || y0));
      const confidence = Math.max(0, Math.min(100, Math.round(Number(unit?.confidence) || 0)));
      const meaningful = meaningfulScore(text);

      if (!text || x1 <= x0 || y1 <= y0) continue;

      rows.push({
        text,
        confidence,
        bbox: { x0, y0, x1, y1 },
        script: scriptHint(text), orientation, kind:'text',
        words:unit.words || [], reviewRequired:confidence < 65 || meaningful < 2
      });
      }
    }
  }

  rows.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
  return assignIds(rows,pageIndex);
}

function verticalCropProposals(passes,width,height) {
  if(!width||!height)return [];
  const seeds=passes.flatMap(p=>p.regions).filter(r=>/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(r.text)&&r.bbox.x1-r.bbox.x0<(r.bbox.y1-r.bbox.y0)*2);
  const groups=[];
  for(const seed of seeds) {
    const b=seed.bbox;
    const near=groups.filter(g=>g.some(r=>{
      const a=r.bbox,w=Math.max(a.x1-a.x0,b.x1-b.x0),h=Math.max(a.y1-a.y0,b.y1-b.y0);
      return Math.abs((a.x0+a.x1-b.x0-b.x1)/2)<Math.max(48,w*3)&&Math.max(0,a.y0-b.y1,b.y0-a.y1)<Math.max(64,h*3);
    }));
    if(!near.length)groups.push([seed]);else{near[0].push(seed);for(const g of near.slice(1)){near[0].push(...g);groups.splice(groups.indexOf(g),1);}}
  }
  return groups.map(g=>{
    const sizes=g.map(r=>Math.max(r.bbox.x1-r.bbox.x0,Math.min(50,r.bbox.y1-r.bbox.y0))).sort((a,b)=>a-b);
    const pad=Math.max(32,sizes[Math.floor(sizes.length/2)]*3);
    const left=Math.max(0,Math.floor(Math.min(...g.map(r=>r.bbox.x0))-pad));
    const top=Math.max(0,Math.floor(Math.min(...g.map(r=>r.bbox.y0))-pad));
    return {left,top,width:Math.min(width,Math.ceil(Math.max(...g.map(r=>r.bbox.x1))+pad))-left,height:Math.min(height,Math.ceil(Math.max(...g.map(r=>r.bbox.y1))+pad))-top};
  });
}

class MangaOcrPool {
  constructor({ langPath, languages = ['eng', 'fra', 'jpn', 'tha'], concurrency = 2, sourceScale = 1, detailDetection = false } = {}) {
    if (!langPath) throw new Error('OCR langPath is required');
    this.langPath = langPath;
    this.languages = languages;
    this.sourceScale=Math.max(1,Number(sourceScale)||1);
    this.detailDetection=Boolean(detailDetection);
    this.baseLanguages=languages.filter(l=>['eng','fra'].includes(l));
    if(!this.baseLanguages.length)this.baseLanguages=languages.includes('tha')?['tha']:['jpn'];
    this.concurrency = Math.max(1, Math.min(4, Number(concurrency) || 3));
    this.workers = [];
  }

  async init() {
    if (this.workers.length) return;
    const settled = await Promise.allSettled(Array.from({ length: this.concurrency }, async () => {
      const worker = await createWorker(this.baseLanguages, OEM.LSTM_ONLY, {
        langPath: this.langPath,
        gzip: true, cacheMethod:'none', workerPath:path.join(__dirname,'ocr-worker.cjs'), errorHandler:()=>{}
      });
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.AUTO,
        user_defined_dpi:'300',
        preserve_interword_spaces: '1'
      });
      return worker;
    }));
    this.workers=settled.filter(r=>r.status==='fulfilled').map(r=>r.value);
    const failure=settled.find(r=>r.status==='rejected');
    if(failure){await this.close();throw failure.reason;}
  }

  async recognizePages(pages, { signal, onStart, onDone, onRegion, mode = 'multi', rectangle } = {}) {
    await this.init();
    const list = Array.isArray(pages) ? pages : [];
    let cursor = 0;
    const results = new Array(list.length);

    const runWorker = async worker => {
      let verticalWorker;
      const additional=new Map();
      const getWorker=async languages=>{
        const key=[...languages].sort().join('+');
        if(key===[...this.baseLanguages].sort().join('+'))return worker;
        if(!additional.has(key))additional.set(key,await createWorker(languages,OEM.LSTM_ONLY,{langPath:this.langPath,gzip:true,cacheMethod:'none',workerPath:path.join(__dirname,'ocr-worker.cjs'),errorHandler:()=>{}}));
        return additional.get(key);
      };
      try {
      while (true) {
        if (signal?.aborted) throw new Error('ยกเลิก OCR');
        const index = cursor++;
        if (index >= list.length) return;
        const page = list[index];
        onStart?.(page, index, list.length);
        const startedAt = Date.now();
        try {
          if(mode!=='diagnostic') {
            const value=await this.recognizeDetected(page,{getWorker,mode,rectangle,signal,onRegion});
            value.ms=Date.now()-startedAt;results[index]=value;onDone?.(page,value,index,list.length);continue;
          }
          const passes=[];
          const plans=mode==='vertical' ? [] : mode==='horizontal' ? [{name:'horizontal',psm:PSM.SINGLE_BLOCK}] : [{name:'auto',psm:PSM.AUTO},{name:'sparse',psm:PSM.SPARSE_TEXT}];
          for(const plan of plans) {
            if(signal?.aborted)throw new Error('ยกเลิก OCR');
            await worker.setParameters({tessedit_pageseg_mode:plan.psm});
            const ret=await worker.recognize(page.filePath,rectangle?{rectangle}:{},{blocks:true,text:true});
            passes.push({name:plan.name,text:normalizeText(ret.data.text),regions:regionsFromBlocks(ret.data.blocks,page.pageIndex??index)});
          }
          if(mode==='vertical'||(mode==='multi'&&this.languages.includes('jpn'))) {
            verticalWorker ||= await createWorker(['jpn_vert'],OEM.LSTM_ONLY,{langPath:this.langPath,gzip:true,cacheMethod:'none',workerPath:path.join(__dirname,'ocr-worker.cjs'),errorHandler:()=>{}});
            await verticalWorker.setParameters({tessedit_pageseg_mode:rectangle?PSM.SINGLE_BLOCK_VERT_TEXT:PSM.AUTO,preserve_interword_spaces:'1'});
            const ret=await verticalWorker.recognize(page.filePath,rectangle?{rectangle}:{},{blocks:true,text:true});
            passes.push({name:'vertical',text:normalizeText(ret.data.text),regions:regionsFromBlocks(ret.data.blocks,page.pageIndex??index,{orientation:'vertical'})});
            if(mode==='multi'&&!rectangle) {
              const proposals=verticalCropProposals(passes.filter(p=>p.name!=='vertical'),page.width,page.height);
              await verticalWorker.setParameters({tessedit_pageseg_mode:PSM.SINGLE_BLOCK_VERT_TEXT});
              for(let i=0;i<proposals.length;i++) {
                if(signal?.aborted)throw new Error('ยกเลิก OCR');
                const crop=await verticalWorker.recognize(page.filePath,{rectangle:proposals[i]},{blocks:true,text:true});
                passes.push({name:`vertical-crop-${i+1}`,rectangle:proposals[i],text:normalizeText(crop.data.text),regions:regionsFromBlocks(crop.data.blocks,page.pageIndex??index,{orientation:'vertical'}).map(r=>({...r,reviewRequired:true}))});
              }
            }
          }
          if (signal?.aborted) throw new Error('ยกเลิก OCR');
          // Full-page vertical OCR can reinterpret horizontal artwork as kana.
          // Keep it in raw passes; include plausible upright columns in the result.
          const selectionPasses=passes.map(p=>({...p,regions:p.name==='vertical'&&mode==='multi'?p.regions.filter(r=>r.bbox.y1-r.bbox.y0>(r.bbox.x1-r.bbox.x0)*.75):p.regions}));
          const regions = fusePasses(selectionPasses,page.pageIndex??index);
          const value = {
            regions,
            text: regions.map(r=>r.text).join('\n\n'), passes,
            ms: Date.now() - startedAt
          };
          results[index] = value;
          onDone?.(page, value, index, list.length);
        } catch (error) {
          const value = { regions: [], text: '', ms: Date.now() - startedAt, error: error.message || String(error) };
          results[index] = value;
          onDone?.(page, value, index, list.length);
        }
      }
      } finally { if(verticalWorker)await verticalWorker.terminate();await Promise.allSettled([...additional.values()].map(w=>w.terminate())); }
    };

    await Promise.all(this.workers.map(runWorker));
    return results;
  }

  async detectPage(input,options){return detectText(input,{signal:options.signal,sourceScale:this.sourceScale,detail:this.detailDetection});}
  async recognizeDetected(page,{getWorker,mode,rectangle,signal,onRegion}) {
    const meta=await sharp(page.filePath).metadata();
    const detected=rectangle ? {engine:'manual-region',width:meta.width,height:meta.height,boxes:[{bbox:{x0:rectangle.left,y0:rectangle.top,x1:rectangle.left+rectangle.width,y1:rectangle.top+rectangle.height},detectedLanguage:'unknown',detectionConfidence:1,orientation:mode==='vertical'?'vertical':'horizontal'}]} : await this.detectPage(page.filePath,{signal,onRegion});
    const regions=[],rejected=[];
    let pageLanguage=this.baseLanguages.includes('tha')?'th':this.baseLanguages.includes('jpn')?'ja':'latin';
    if(mode==='vertical')pageLanguage='ja';
    for(const [index,candidate] of detected.boxes.entries()){
      onRegion?.({index:index+1,total:detected.boxes.length,engine:'tesseract'});
      if(signal?.aborted)throw new Error('ยกเลิก OCR');
      const b=candidate.bbox,pad=6;
      const x0=Math.max(0,b.x0-pad),y0=Math.max(0,b.y0-pad),x1=Math.min(meta.width,b.x1+pad),y1=Math.min(meta.height,b.y1+pad);
      const scale=Math.min(3,Math.max(1,Math.min(1000/(x1-x0),2))),border=12;
      const resizedWidth=Math.max(1,Math.round((x1-x0)*scale)),resizedHeight=Math.max(1,Math.round((y1-y0)*scale));
      const sx=resizedWidth/(x1-x0),sy=resizedHeight/(y1-y0);
      const crop=await sharp(page.filePath).extract({left:x0,top:y0,width:x1-x0,height:y1-y0}).resize(resizedWidth,resizedHeight,{fit:'fill',kernel:'cubic'}).flatten({background:'#fff'}).extend({top:border,bottom:border,left:border,right:border,background:'#fff'}).png().toBuffer();
      const japanese=pageLanguage==='ja';
      let orientation=japanese&&(mode==='vertical'||b.y1-b.y0>(b.x1-b.x0)*1.1)?'vertical':'horizontal';
      if(rectangle&&mode==='vertical')orientation='vertical';
      let languages=japanese?[orientation==='vertical'?'jpn_vert':'jpn']:pageLanguage==='th'?['tha']:this.baseLanguages;
      const recognize=async langs=>{
        const active=await getWorker(langs);
        await active.setParameters({tessedit_pageseg_mode:langs.includes('jpn_vert')?PSM.SINGLE_BLOCK_VERT_TEXT:PSM.SINGLE_BLOCK,preserve_interword_spaces:'1',user_defined_dpi:'300'});
        const ret=await active.recognize(crop,{},{blocks:true,text:true});
        return {text:normalizeText(ret.data.text),confidence:Number(ret.data.confidence)||0,blocks:ret.data.blocks,languages:langs};
      };
      let read=await recognize(languages);
      if(this.languages.includes('jpn')&&!japanese&&(read.confidence<45||(candidate.orientation==='vertical'&&b.y1-b.y0>(b.x1-b.x0)*1.5&&read.confidence<80))){const jp=await recognize([candidate.orientation==='vertical'?'jpn_vert':'jpn']);const count=(jp.text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)||[]).length;if(count>=3&&jp.confidence>=80&&jp.confidence>read.confidence+15){read=jp;orientation=candidate.orientation;}}
      if(this.languages.includes('tha')&&pageLanguage==='latin'&&read.confidence<70){const th=await recognize(['tha']);const count=(th.text.match(/\p{Script=Thai}/gu)||[]).length;if(count>=5&&th.confidence>=80&&th.confidence>read.confidence+25)read=th;}
      if(candidate.uncovered)for(const block of read.blocks||[])for(const paragraph of block.paragraphs||[]){paragraph.lines=(paragraph.lines||[]).filter(line=>meaningfulScore(line.text)>=2&&line.confidence>=65);}
      let local=regionsFromBlocks(read.blocks,page.pageIndex||0,{orientation});
      if(candidate.uncovered){local=local.filter(r=>meaningfulScore(r.text)>=2&&r.confidence>=65);read.text=local.map(r=>r.text).join('\n');}
      const words=local.flatMap(r=>r.words||[]).map(w=>({text:w.text,confidence:w.confidence,bbox:{x0:x0+(w.bbox.x0-border)/sx,y0:y0+(w.bbox.y0-border)/sy,x1:x0+(w.bbox.x1-border)/sx,y1:y0+(w.bbox.y1-border)/sy}}));
      const row={bbox:{...b},text:read.text,confidence:Math.round(read.confidence),detectionConfidence:Math.round(candidate.detectionConfidence*100),
        orientation,script:scriptHint(read.text),kind:candidate.kind||'text',words,observedBy:['comic-text-detector','region-ocr'],recognitionLanguages:read.languages,
        reviewRequired:read.confidence<75||!read.text||candidate.lineOnly,detector:detected.engine,containerId:candidate.containerId,containerBBox:candidate.containerBBox};
      if(candidate.uncovered&&words.length){row.bbox={x0:Math.max(b.x0,Math.floor(Math.min(...words.map(w=>w.bbox.x0))-3)),y0:Math.max(b.y0,Math.floor(Math.min(...words.map(w=>w.bbox.y0))-3)),x1:Math.min(b.x1,Math.ceil(Math.max(...words.map(w=>w.bbox.x1))+3)),y1:Math.min(b.y1,Math.ceil(Math.max(...words.map(w=>w.bbox.y1))+3))};}
      if(candidate.uncovered&&words.length){
        const tight=row.bbox,left=Math.max(0,tight.x0-4),top=Math.max(0,tight.y0-4);
        const clean=await sharp(page.filePath).extract({left,top,width:Math.min(meta.width,tight.x1+4)-left,height:Math.min(meta.height,tight.y1+4)-top}).resize({width:(tight.x1-tight.x0+8)*3}).extend({top:12,bottom:12,left:12,right:12,background:'#fff'}).png().toBuffer();
        const active=await getWorker(read.languages);await active.setParameters({tessedit_pageseg_mode:PSM.SINGLE_BLOCK});
        const improved=(await active.recognize(clean,{},{text:true})).data;
        if(improved.confidence>row.confidence&&meaningfulScore(improved.text)>=2){row.text=normalizeText(improved.text);row.confidence=improved.confidence;}
      }
      if(candidate.lineOnly&&(read.confidence<(candidate.uncovered?65:45)||!read.text))rejected.push({...row,rejectionReason:'line recognition uncertain'});else regions.push(row);
    }
    const accepted=assignIds(regions,page.pageIndex||0),uncertain=assignIds(rejected,page.pageIndex||0);
    return {regions:accepted,rejectedRegions:uncertain,text:accepted.map(r=>r.text).join('\n\n'),detection:{...detected,pageLanguage},
      passes:[{name:'detector',regions:assignIds(detected.boxes.map(b=>({...b,text:'',confidence:Math.round(b.detectionConfidence*100)})),page.pageIndex||0)},
        {name:'recognized',regions:accepted},{name:'uncertain',regions:uncertain}]};
  }

  async close() {
    const workers = this.workers.splice(0);
    await Promise.allSettled(workers.map(worker => worker.terminate()));
  }
}

module.exports = {
  normalizeText,
  meaningfulScore,
  scriptHint,
  regionsFromBlocks,
  verticalCropProposals,
  MangaOcrPool
};
