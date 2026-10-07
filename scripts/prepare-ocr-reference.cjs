'use strict';
// Prepare crops only. Reference text must be read from the image and reviewed.
const fs=require('node:fs/promises'),path=require('node:path'),sharp=require('sharp'),crypto=require('node:crypto');
async function main(){
 const out=path.resolve('test-results/engine-comparison');await fs.mkdir(out,{recursive:true});
 const plan=[[2,2,[0,2,6,8,9,10]],[2,3,[1,2,3]],[3,3,[0,1]],[4,2,[0,1,4,9]],[4,3,[9,16]],[5,2,[0,2]],[5,3,[0,1]],[6,3,[1,2,3,4,5,6]],[7,2,[0,3,6,9,14]]];
 const cases=[];
 for(const [set,page,indices]of plan){
  const root=path.resolve('test-results/new-sets/set-'+set),files=JSON.parse(await fs.readFile(path.join(root,'files.json'),'utf8'));
  const source=files[page-1],buffer=await fs.readFile(source),meta=await sharp(buffer).metadata();
  const results=JSON.parse(await fs.readFile(path.join(root,'ocr-'+page+'.json'),'utf8'));
  for(const index of indices){
   const r=results.regions[index],b=r.bbox,pad=10,x0=Math.max(0,b.x0-pad),y0=Math.max(0,b.y0-pad),x1=Math.min(meta.width,b.x1+pad),y1=Math.min(meta.height,b.y1+pad);
   const id=`s${set}-p${page}-r${index}`,file=path.join(out,id+'.png');
   await sharp(buffer).extract({left:x0,top:y0,width:x1-x0,height:y1-y0}).png().toFile(file);
   cases.push({id,set,page,source,digest:crypto.createHash('sha256').update(buffer).digest('hex'),roi:{x0,y0,x1,y1},file:path.basename(file),language:set===6?'ja':'en',split:page===2?'development':'holdout',text:null,verified:false,baseline:r.text});
  }
 }
 await fs.writeFile(path.join(out,'reference-draft.json'),JSON.stringify({schema:'imageharvest.ocr-crop-reference',version:1,scope:'Crop recognition only; not full-page detection completeness.',cases},null,2));
 for(let offset=0;offset<cases.length;offset+=12){
  const batch=cases.slice(offset,offset+12),tiles=[];
  for(const [i,c]of batch.entries()){
   const png=await sharp(path.join(out,c.file)).resize(290,235,{fit:'inside',withoutEnlargement:false}).png().toBuffer();
   const label=Buffer.from(`<svg width="300" height="28"><rect width="300" height="28" fill="#d8e6ef"/><text x="8" y="20" font-size="16">${c.id}</text></svg>`);
   const tile=await sharp({create:{width:300,height:270,channels:3,background:'#fff'}}).composite([{input:label,left:0,top:0},{input:png,left:5,top:30}]).png().toBuffer();
   tiles.push({input:tile,left:(i%4)*300,top:Math.floor(i/4)*270});
  }
  await sharp({create:{width:1200,height:Math.ceil(batch.length/4)*270,channels:3,background:'#eee'}}).composite(tiles).png().toFile(path.join(out,'crops-'+(offset/12+1)+'.png'));
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
