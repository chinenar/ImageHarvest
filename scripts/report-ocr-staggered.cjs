'use strict';
const fs=require('node:fs/promises'),sharp=require('sharp');
const root='test-results/ocr-accuracy';
const expected=["I feel like I've grown a bit.","I've also moved from growing on the stone to in the ground.","Is it the work of the goddess?"];
const canonical=s=>s.toLowerCase().replace(/[^a-z0-9]/g,'');
const escape=s=>s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function main(){
 const reads=await Promise.all(['holdout-1.6.73','holdout'].map(async d=>JSON.parse(await fs.readFile(`${root}/${d}/angled-dialogue-page.json`,'utf8'))));
 if(reads[0].source!==reads[1].source)throw Error('Different sources');
 const crop={left:55,top:840,width:430,height:440},source=await sharp(reads[1].source).extract(crop).png().toBuffer();
 const panels=[],details=[];
 for(const [i,data]of reads.entries()){
  const rows=data.result.regions.filter(r=>r.bbox.x0<470&&r.bbox.y0>880&&r.bbox.y0<1250);
  details.push({phase:i?'after':'before',units:expected.map(text=>({expected:text,matches:rows.filter(r=>canonical(r.text)===canonical(text)).length,exactPunctuation:rows.some(r=>r.text.replace(/\s/g,'').toLowerCase()===text.replace(/\s/g,'').toLowerCase())})),readings:rows.map(r=>({text:r.text,bbox:r.bbox,ownedPolygons:r.ownedPolygons}))});
  const shapes=rows.map(r=>{const b=r.bbox;return `<rect x="${b.x0-crop.left}" y="${b.y0-crop.top}" width="${b.x1-b.x0}" height="${b.y1-b.y0}" fill="none" stroke="#e78a00" stroke-width="2"/>${(r.ownedPolygons||[]).map(p=>`<polygon points="${p.map(([x,y])=>`${x-crop.left},${y-crop.top}`).join(' ')}" fill="none" stroke="#008755" stroke-width="2"/>`).join('')}`;}).join('');
  panels.push({input:await sharp(source).composite([{input:Buffer.from(`<svg width="430" height="440">${shapes}</svg>`)}]).png().toBuffer(),left:i*430,top:30});
 }
 const header=Buffer.from('<svg width="860" height="30"><text x="10" y="22" font-size="18">Before 1.6.73</text><text x="440" y="22" font-size="18">After 1.6.74</text></svg>');
 const image=await sharp({create:{width:860,height:470,channels:3,background:'#fff'}}).composite([...panels,{input:header,left:0,top:0}]).png().toBuffer();
 await fs.writeFile(`${root}/staggered-comparison.png`,image);
 await fs.writeFile(`${root}/staggered-comparison.json`,JSON.stringify({source:reads[1].source,scope:'Three manually transcribed development units within the marked source area; not whole-page accuracy.',details},null,2));
 await fs.writeFile(`${root}/staggered-report.html`,`<!doctype html><meta charset="utf-8"><title>OCR 1.6.74 comparison</title><style>body{font:18px system-ui;max-width:1000px;margin:30px auto}img{width:100%}pre{white-space:pre-wrap;background:#f2f4f6;padding:20px}</style><h1>Adjacent and slanted dialogue</h1><p>Three source text units: unique lexical matches 0/3 → 3/3; exact punctuation 2/3 after. These are development cases, not whole-page accuracy. Orange = rectangle; green = slanted crop mask. Overlapping rectangles no longer mean the neighboring glyphs are fed into OCR.</p><img src="data:image/png;base64,${image.toString('base64')}"><pre>${escape(JSON.stringify(details,null,2))}</pre><p>Unresolved: complete SFX classification, tiny multilingual tables, and some punctuation/Chinese transcription. Timing is not a controlled speed comparison.</p>`);
 console.log(JSON.stringify(details.map(d=>({phase:d.phase,units:d.units}))));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
