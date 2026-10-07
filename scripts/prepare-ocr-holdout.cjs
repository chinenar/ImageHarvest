'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),sharp=require('sharp'),crypto=require('node:crypto');
async function main(){
 const out=path.resolve('test-results/engine-comparison'),cases=[],tiles=[];
 for(const [set,page,indices]of [...Array.from({length:6},(_,i)=>[i+2,4,[0,2,4]]),[6,5,[0,1,2]],[6,6,[0,1,2]]]){
  const dir=path.resolve('test-results/new-sets/set-'+set),files=JSON.parse(await fs.readFile(path.join(dir,'files.json'),'utf8'));
  const source=files[page-1],buffer=await fs.readFile(source),meta=await sharp(buffer).metadata(),r=JSON.parse(await fs.readFile(path.join(dir,'ocr-'+page+'.json'),'utf8'));
  for(const index of indices.filter(i=>i<r.regions.length)){
   const b=r.regions[index].bbox,roi={x0:Math.max(0,b.x0-10),y0:Math.max(0,b.y0-10),x1:Math.min(meta.width,b.x1+10),y1:Math.min(meta.height,b.y1+10)};
   const id=`holdout-s${set}-p${page}-r${index}`,file=id+'.png';
   const crop=await sharp(buffer).extract({left:roi.x0,top:roi.y0,width:roi.x1-roi.x0,height:roi.y1-roi.y0}).png().toBuffer();await fs.writeFile(path.join(out,file),crop);
   cases.push({id,source,digest:crypto.createHash('sha256').update(buffer).digest('hex'),roi,file,language:set===6?'ja':'en',split:'holdout',text:null,verified:false});
   const small=await sharp(crop).resize(290,250,{fit:'inside'}).png().toBuffer(),i=tiles.length;
   const label=Buffer.from(`<svg width="300" height="28"><rect width="300" height="28" fill="#d8e6ef"/><text x="8" y="20" font-size="16">${id}</text></svg>`);
   const tile=await sharp({create:{width:300,height:285,channels:3,background:'#fff'}}).composite([{input:label,left:0,top:0},{input:small,left:5,top:30}]).png().toBuffer();tiles.push({input:tile,left:(i%4)*300,top:Math.floor(i/4)*285});
  }
 }
 await sharp({create:{width:1200,height:Math.ceil(tiles.length/4)*285,channels:3,background:'#eee'}}).composite(tiles).png().toFile(path.join(out,'holdout-crops.png'));
 await fs.writeFile(path.join(out,'holdout-draft.json'),JSON.stringify(cases,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
