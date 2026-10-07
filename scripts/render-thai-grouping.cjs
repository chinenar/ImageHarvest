'use strict';
// Render actual OCR Lab results in original screenshot coordinates.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),sharp=require('sharp');
(async()=>{
 const root=path.resolve(__dirname,'..'),dir=path.join(root,'test-results/ocr-lab');
 const input=await fs.readFile(path.join(dir,'thai-cropped.png'));
 const result=JSON.parse(await fs.readFile(path.join(dir,'thai-cropped-fixed.json'),'utf8'));
 if(crypto.createHash('sha256').update(input).digest('hex')!==result.imageDigest)throw Error('OCR result belongs to another image');
 const {width,height}=await sharp(input).metadata();
 const overlay=Buffer.from(`<svg width="${width}" height="${height}">${result.regions.map(r=>{const b=r.bbox;return `<rect x="${b.x0}" y="${b.y0}" width="${b.x1-b.x0}" height="${b.y1-b.y0}" fill="none" stroke="#ff70a8" stroke-width="2"/>`;}).join('')}</svg>`);
 const output=path.join(root,'test-results/thai-split/fixed.png');await sharp(input).composite([{input:overlay}]).png().toFile(output);
 console.log(JSON.stringify({output,version:result.appVersion,regions:result.regions.length,text:result.regions.map(r=>r.text),imageDigest:result.imageDigest}));
})().catch(error=>{console.error(error);process.exitCode=1;});
