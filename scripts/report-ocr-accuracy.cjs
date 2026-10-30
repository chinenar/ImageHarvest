'use strict';
// Recompute scores from saved reads; generating the report never runs OCR.
const fs=require('node:fs/promises'),path=require('node:path'),sharp=require('sharp');
const {metrics}=require('./benchmark-ocr-accuracy.cjs');
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function main(){
 const root=path.resolve('test-results/ocr-accuracy');
 const reference=JSON.parse(await fs.readFile('test/fixtures/ocr-accuracy-reference.json','utf8'));
 const summary=[],cards=[];
 for(const c of reference.cases){
  const before=JSON.parse(await fs.readFile(path.join(root,'full-before',c.id+'.json'),'utf8'));
  const after=JSON.parse(await fs.readFile(path.join(root,'after',c.id+'.json'),'utf8'));
  if(before.digest!==after.digest)throw Error('Source image differs: '+c.id);
  const a=metrics(before.result.regions,before.reference),b=metrics(after.result.regions,after.reference);
  summary.push({id:c.id,before:a,after:b});
  let img=sharp(after.source);if(c.crop){const [left,top,width,height]=c.crop;img=img.extract({left,top,width,height});}
  const buffer=await img.png().toBuffer(),meta=await sharp(buffer).metadata();
  const offset=c.crop||[0,0],w=meta.width,h=meta.height;
  const rect=(box,color,title)=>{const x=box.x0-offset[0],y=box.y0-offset[1];if(x>=w||y>=h||box.x1-offset[0]<=0||box.y1-offset[1]<=0)return '';return `<rect x="${x}" y="${y}" width="${box.x1-box.x0}" height="${box.y1-box.y0}" fill="none" stroke="${color}" stroke-width="2"><title>${escape(title)}</title></rect>`;};
  const panel=(data,label)=>`<div><h3>${label}</h3><svg viewBox="0 0 ${w} ${h}"><image width="${w}" height="${h}" href="data:image/png;base64,${buffer.toString('base64')}"/>${data.reference.units.map(u=>rect({x0:u.box[0],y0:u.box[1],x1:u.box[2],y1:u.box[3]},'#00ac58','Reference: '+u.text)).join('')}${data.result.regions.map(r=>rect(r.bbox,'#ef8a00',r.text)).join('')}</svg></div>`;
  cards.push(`<article><h2>${escape(c.id)}</h2><p>Unique lexical matches: ${a.exact}/${a.expected} → ${b.exact}/${b.expected}. Negative-area detections: ${a.negativeDetections.length} → ${b.negativeDetections.length}.</p><div class="pair">${panel(before,'Before 1.6.72')}${panel(after,'After')}</div><table><tr><th>Reference</th><th>Before</th><th>After</th><th>Exact punctuation after</th></tr>${b.units.map((u,i)=>`<tr><td>${escape(u.expected)}</td><td>${escape(a.units[i].actual)}</td><td>${escape(u.actual)}</td><td>${u.exactTranscription?'Yes':'No'}</td></tr>`).join('')}</table></article>`);
 }
 const totals=key=>summary.reduce((t,c)=>({exact:t.exact+c[key].exact,expected:t.expected+c[key].expected,exactTranscription:t.exactTranscription+c[key].units.filter(u=>u.exactTranscription&&u.matches===1).length}),{exact:0,expected:0,exactTranscription:0});
 const holdouts=[];
 for(const id of ['en-real-page','ja-real-page','th-synthetic-page','zh-vertical-page','angled-dialogue-page']){
  const reads=await Promise.all(['holdout-before','holdout'].map(async p=>JSON.parse(await fs.readFile(path.join(root,p,id+'.json'),'utf8'))));
  holdouts.push({id,...Object.fromEntries(reads.map((r,i)=>[i?'after':'before',{regions:r.result.regions.length,matched:r.metrics?.matched,expected:r.metrics?.expected,matchedCharacterEdits:r.metrics?.pairs.reduce((s,p)=>s+p.edits,0),ms:r.ms}]))});
 }
 const result={scope:'Development reference excerpts evaluated in full native source pages. Not a whole-corpus accuracy estimate. Holdout pages were also inspected during iteration; they are regression checks, not an untouched test set.',before:totals('before'),after:totals('after'),cases:summary,regression:holdouts};
 await fs.writeFile(path.join(root,'summary.json'),JSON.stringify(result,null,2));
 const html=`<!doctype html><meta charset="utf-8"><title>OCR source comparison</title><style>body{font:16px system-ui;max-width:1500px;margin:32px auto;padding:0 24px;background:#f4f6f9;color:#17212f}article{background:white;padding:20px;margin:28px 0;border-radius:12px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:20px}svg{width:100%;max-height:900px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccd3df;padding:10px;text-align:left;white-space:pre-line}h3{margin:12px 0}</style><h1>OCR: source-level before / after</h1><p>${escape(result.scope)}</p><p>Green = manual text extent. Orange = returned region. Hover a rectangle to read its OCR text. Rectangle overlap alone does not establish ownership.</p><p>Unique lexical matches ${result.before.exact}/${result.before.expected} → ${result.after.exact}/${result.after.expected}; exact punctuation after ${result.after.exactTranscription}/${result.after.expected}.</p><p><strong>Unresolved:</strong> dense Japanese status tables and some Chinese characters still require correction. The repaired three-unit slanted-dialogue example has a separate <a href="staggered-report.html">source comparison</a>. SFX classification is not comprehensively solved. Region-count reduction is not a character-accuracy score. Timings are single local runs, not a controlled competitor speed comparison.</p><h2>Regression checks</h2><pre>${escape(JSON.stringify(holdouts,null,2))}</pre>${cards.join('')}`;
 await fs.writeFile(path.join(root,'report.html'),html);console.log(JSON.stringify({before:result.before,after:result.after,report:path.join(root,'report.html')}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
