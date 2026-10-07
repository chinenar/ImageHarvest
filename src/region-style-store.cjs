'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
function regionStyleKey(page,region,targetLanguage='th'){
  if(!page.imageDigest||!region.bbox)throw Error('ไม่พบข้อมูลภาพสำหรับบันทึกขนาดตัวอักษร');
  return createHash('sha256').update(JSON.stringify([page.imageDigest,targetLanguage,region.original??region.text,['x0','y0','x1','y1'].map(k=>Number(region.bbox[k]))])).digest('hex');
}
function normalizeRegionStyle(value){
  if(value===null)return null;
  const style={};
  if(value?.fontSizeImagePx!==undefined&&value?.fontSizeImagePx!==null){
    const fontSizeImagePx=Number(value.fontSizeImagePx);
    if(!Number.isFinite(fontSizeImagePx)||fontSizeImagePx<1||fontSizeImagePx>4096)throw Error('ขนาดตัวอักษรไม่ถูกต้อง');
    style.fontSizeImagePx=Math.round(fontSizeImagePx*1000)/1000;
  }
  if(value?.text!==undefined&&value?.text!==null){
    const text=String(value.text);
    if(text.length>10000)throw Error('ข้อความแปลยาวเกินไป');
    style.text=text;
  }
  if(value?.box!==undefined&&value?.box!==null){
    const source=value.box,box={};
    for(const key of ['x0','y0','x1','y1']){
      const n=Number(source[key]);
      if(!Number.isFinite(n)||n<0||n>1)throw Error('ตำแหน่งกรอบข้อความไม่ถูกต้อง');
      box[key]=Math.round(n*1000000)/1000000;
    }
    if(box.x1-box.x0<.002||box.y1-box.y0<.002)throw Error('กรอบข้อความเล็กเกินไป');
    style.box=box;
  }
  return Object.keys(style).length?style:null;
}
class RegionStyleStore{
  constructor(file){this.file=file;this.queue=Promise.resolve();this.data=null;}
  async read(){
    if(this.data)return this.data;
    try{const value=JSON.parse(await fs.readFile(this.file,'utf8'));this.data=value.version===1&&value.entries&&typeof value.entries==='object'?value.entries:{};}
    catch(error){if(error.code!=='ENOENT')throw error;this.data={};}
    return this.data;
  }
  async get(key){return (await this.read())[key]?.style||null;}
  set(key,value){
    if(!/^[0-9a-f]{64}$/.test(key))return Promise.reject(Error('ID การตั้งค่ากล่องข้อความไม่ถูกต้อง'));
    let style;try{style=normalizeRegionStyle(value);}catch(e){return Promise.reject(e);}
    const task=this.queue.then(async()=>{
      const previous=await this.read(),next={...previous};
      if(style)next[key]={style,updatedAt:Date.now()};else delete next[key];
      const sorted=Object.keys(next).sort((a,b)=>next[b].updatedAt-next[a].updatedAt);
      for(const old of sorted.slice(5000))delete next[old];
      await fs.mkdir(path.dirname(this.file),{recursive:true});
      const temp=this.file+'.'+randomUUID()+'.tmp';
      try{
        await fs.writeFile(temp,JSON.stringify({version:1,entries:next}),'utf8');
        for(let n=0;;n++){try{await fs.rename(temp,this.file);break;}catch(e){if(n>=4||!['EPERM','EBUSY','EACCES'].includes(e.code))throw e;await new Promise(r=>setTimeout(r,50*(n+1)));}}
        this.data=next;return style;
      }finally{await fs.rm(temp,{force:true}).catch(()=>{});}
    });
    this.queue=task.catch(()=>{});return task;
  }
}
module.exports={RegionStyleStore,regionStyleKey,normalizeRegionStyle};
