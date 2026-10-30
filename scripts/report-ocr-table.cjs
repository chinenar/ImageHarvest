'use strict';
const fs=require('node:fs/promises'),sharp=require('sharp');
const {editDistance,area,intersection}=require('../src/ocr-review.cjs');
const root='test-results/ocr-accuracy';
const normalize=s=>s.normalize('NFKC').replace(/\s/g,'');
const escape=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function main(){
 const reference=JSON.parse(await fs.readFile('test/fixtures/ocr-table-reference.json','utf8'));
 const reads=await Promise.all([`${root}/holdout-1.6.74/angled-dialogue-page.json`,`${root}/table-targeted.json`].map(async p=>JSON.parse(await fs.readFile(p,'utf8'))));
 const phases=reads.map((r,index)=>({phase:index?'after':'before',acceleration:r.result.performance?.acceleration,units:reference.units.map(u=>{
  const [x0,y0,x1,y1]=u.box,b={x0,y0,x1,y1};
  const candidates=r.result.regions.filter(row=>intersection(row.bbox,b)/Math.max(1,area(b))>.6);
  const row=candidates.sort((a,b)=>editDistance(normalize(a.text),normalize(u.text))-editDistance(normalize(b.text),normalize(u.text)))[0];
  return {id:u.id,expected:u.text,actual:row?.text||'',edits:editDistance(normalize(row?.text||''),normalize(u.text)),characters:Array.from(normalize(u.text)).length,languageEvidence:row?.regionLanguageEvidence};
 })}));
 const image=await sharp(reads[1].source).extract({left:350,top:1400,width:580,height:340}).png().toBuffer();
 await fs.writeFile(`${root}/table-comparison.json`,JSON.stringify({scope:reference.scope+' After: recognition on frozen detector proposals, not a detector evaluation.',source:reads[1].source,phases},null,2));
 await fs.writeFile(`${root}/table-report.html`,`<!doctype html><meta charset="utf-8"><title>OCR mixed-language table</title><style>body{font:18px system-ui;max-width:1100px;margin:30px auto}img{width:100%}table{width:100%;border-collapse:collapse}td,th{border:1px solid #bbb;padding:15px;white-space:pre-wrap}pre{white-space:pre-wrap}</style><h1>Small Japanese text on an English page</h1><p>${escape(reference.scope)} After: recognition on frozen model proposals, not a full-page detector evaluation.</p><img src="data:image/png;base64,${image.toString('base64')}"><table><tr><th>Reference</th><th>1.6.74</th><th>After</th></tr>${reference.units.map((u,i)=>`<tr><td>${escape(u.text)}</td><td>${escape(phases[0].units[i].actual)}<br>Character edits: ${phases[0].units[i].edits}</td><td>${escape(phases[1].units[i].actual)}<br>Character edits: ${phases[1].units[i].edits}</td></tr>`).join('')}</table><p>The whole table is not solved. Other labels, mixed artwork/table regions, and automatic sound-effect classification still need work. Explicit SFX marking now preserves the source and prevents translation/painting, including when uncertain translation is enabled.</p>`);
 console.log(JSON.stringify(phases.map(p=>({phase:p.phase,edits:p.units.reduce((s,u)=>s+u.edits,0),characters:p.units.reduce((s,u)=>s+u.characters,0),units:p.units.map(u=>({id:u.id,edits:u.edits}))}))));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
