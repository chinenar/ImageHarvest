'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),sharp=require('sharp');
async function main(){
 const out=path.resolve('test-results/engine-comparison'),files=JSON.parse(await fs.readFile('test-results/new-sets/set-4/files.json','utf8'));
 const old=JSON.parse(await fs.readFile('test-results/new-sets/set-4/ocr-2.json','utf8')).regions.filter(r=>r.bbox.y0>2400&&r.bbox.y0<2500);
 const newer=JSON.parse(await fs.readFile(path.join(out,'paired-page-result.json'),'utf8')).regions.filter(r=>r.segmentation&&r.bbox.y0>2300&&r.bbox.y0<2650);
 const roi={left:440,top:2350,width:250,height:350},crop=await sharp(files[1]).extract(roi).png().toBuffer(),panels=[];
 for(const [index,{regions,label,color}]of [{regions:old,label:'Before: merged',color:'#ef4f91'},{regions:newer,label:'After: two groups',color:'#15966d'}].entries()){
  const rects=regions.map((r,i)=>{const b=r.bbox,x=b.x0-roi.left,y=b.y0-roi.top;return `<rect x="${x}" y="${y}" width="${b.x1-b.x0}" height="${b.y1-b.y0}" fill="none" stroke="${color}" stroke-width="2"/><rect x="${x}" y="${y-18}" width="22" height="18" fill="${color}"/><text x="${x+6}" y="${y-5}" font-size="12" fill="white">${i+1}</text>`;}).join('');
  const overlay=Buffer.from(`<svg width="250" height="350">${rects}</svg>`),image=await sharp(crop).composite([{input:overlay}]).png().toBuffer();
  const header=Buffer.from(`<svg width="270" height="35"><rect width="270" height="35" fill="#151926"/><text x="12" y="24" font-size="17" fill="white">${label}</text></svg>`);
  const panel=await sharp({create:{width:270,height:395,channels:3,background:'#151926'}}).composite([{input:header,left:0,top:0},{input:image,left:10,top:35}]).png().toBuffer();
  panels.push({input:panel,left:index*280,top:0});
 }
 await sharp({create:{width:550,height:395,channels:3,background:'#151926'}}).composite(panels).png().toFile(path.join(out,'connected-balloons-before-after.png'));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
