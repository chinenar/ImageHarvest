'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),sharp=require('sharp');
const {EnhancedMangaOcrPool}=require('../src/enhanced-manga-ocr.cjs');
const {annotateContent}=require('../src/ocr-content-role.cjs');
(async()=>{
 const source=require('../test-results/new-sets/set-2/files.json')[36],buffer=await fs.readFile(source),out=path.resolve('test-results/ocr-speed');
 const pool=new EnhancedMangaOcrPool({langPath:path.resolve('assets/tessdata'),languages:['eng','fra','jpn','tha'],concurrency:1});
 let result;try{[result]=await pool.recognizePages([{filePath:source}],{onRegion:p=>{if(p.index===1||p.index===p.total)console.log(p.phase||p.engine,p.index+'/'+p.total);}});}finally{await pool.close();}
 if(result.error)throw Error(result.error);result.regions=annotateContent(result.regions);
 const data={source,imageDigest:crypto.createHash('sha256').update(buffer).digest('hex'),appVersion:require('../package.json').version,...result};await fs.writeFile(path.join(out,'user-page-result.json'),JSON.stringify(data,null,2));
 const meta=await sharp(buffer).metadata(),escape=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
 const marks=result.regions.map((r,i)=>{const b=r.bbox,color=r.contentRole.role==='watermark'?'#777':r.contentRole.excluded?'#e44':'#5a2';return `<rect x="${b.x0}" y="${b.y0}" width="${b.x1-b.x0}" height="${b.y1-b.y0}" fill="none" stroke="${color}" stroke-width="3"/><text x="${b.x0}" y="${Math.max(18,b.y0-4)}" font-size="18" fill="${color}" stroke="white" stroke-width="2" paint-order="stroke">${i+1} ${escape(r.contentRole.role)}</text>`;}).join('');
 const rendered=await sharp(buffer).composite([{input:Buffer.from(`<svg width="${meta.width}" height="${meta.height}">${marks}</svg>`)}]).png().toBuffer();await sharp(rendered).resize({height:1100}).png().toFile(path.join(out,'user-page-checked.png'));
 console.log(JSON.stringify({ms:result.ms,regions:result.regions.map(r=>({text:r.text,bbox:r.bbox,confidence:r.confidence,role:r.contentRole})),rejected:result.rejectedRegions.length},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
