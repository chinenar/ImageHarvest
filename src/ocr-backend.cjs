'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process'),{createHash}=require('node:crypto'),readline=require('node:readline');
const runtimeRoot=()=>path.join(process.env.LOCALAPPDATA||os.homedir(),'ImageHarvest','ocr-runtime');
class LocalOcrBackend {
  constructor({python,timeout=240000,device='auto'}={}){this.python=python||path.join(runtimeRoot(),'Scripts','python.exe');this.timeout=timeout;this.device=device;this.pending=new Map();this.sequence=0;this.logs='';this.timings=new Map();this.readQueue=[];this.batchEnabled=false;this.commandQueue=Promise.resolve();}
  stats(){return Object.fromEntries([...this.timings].map(([key,value])=>[key,{...value}]));}
  async start(){
    if(this.child)return;
    if(this.starting)return this.starting;
    this.starting=this.launch();
    try{await this.starting;}finally{this.starting=null;}
  }
  async launch(){
    await fs.access(this.python).catch(()=>{throw Error('ยังไม่ได้ติดตั้งเอนจิน OCR เพิ่มเติม • ใช้ scripts/setup-ocr-runtime.ps1');});
    const source=await fs.readFile(path.join(__dirname,'ocr-backend.py'));
    const geometry=await fs.readFile(path.join(__dirname,'reader_surface.py'));
    const dir=path.join(runtimeRoot(),'worker',createHash('sha256').update(source).update(geometry).digest('hex').slice(0,16));await fs.mkdir(dir,{recursive:true});
    const script=path.join(dir,'ocr-backend.py');await fs.writeFile(script,source);await fs.writeFile(path.join(dir,'reader_surface.py'),geometry);
    const child=this.child=spawn(this.python,['-u',script],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8',...(this.device!=='auto'?{IMAGEHARVEST_OCR_DEVICE:this.device}:{})}});
    child.stderr.on('data',chunk=>{this.logs=(this.logs+chunk).slice(-8000);});
    readline.createInterface({input:child.stdout}).on('line',line=>{
      let data;try{data=JSON.parse(line);}catch{return;}
      const pending=this.pending.get(data.id);if(!pending)return;this.pending.delete(data.id);pending.cleanup();
      const timing=this.timings.get(pending.key)||{calls:0,wallMs:0,workerMs:0};timing.calls++;timing.wallMs+=Date.now()-pending.started;timing.workerMs+=data.workerMs||0;this.timings.set(pending.key,timing);
      if(data.error)pending.reject(Error(data.error));else pending.resolve(data.result);
    });
    const failed=error=>{if(this.child!==child)return;this.child=null;for(const p of this.pending.values()){p.cleanup();p.reject(error);}this.pending.clear();};
    child.on('error',failed);child.on('exit',code=>failed(Error('Local OCR worker exited '+code+' '+this.logs.slice(-1000))));
  }
  request(data,{signal}={}){
    if(signal?.aborted)return Promise.reject(Error('ยกเลิก OCR'));
    // The Python worker reads one JSON command at a time. Queue commands here
    // so the per-request timeout starts only when that command actually runs,
    // not while it is waiting behind work from other OCR pages.
    const task=this.commandQueue.catch(()=>{}).then(()=>this.requestNow(data,{signal}));
    this.commandQueue=task.then(()=>undefined,()=>undefined);
    return task;
  }
  async requestNow(data,{signal}={}){
    if(signal?.aborted)throw Error('ยกเลิก OCR');await this.start();if(signal?.aborted){this.close();throw Error('ยกเลิก OCR');}const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const abort=()=>this.close(Error('ยกเลิก OCR'));
      const timer=setTimeout(()=>this.close(Error('OCR เพิ่มเติมใช้เวลานานเกินกำหนด')),this.timeout);
      const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
      signal?.addEventListener('abort',abort,{once:true});this.pending.set(id,{resolve,reject,cleanup,started:Date.now(),key:[data.op||data.engine,data.op==='recognize-batch'?data.engine:null,data.language,data.variant].filter(Boolean).join('/')});
      this.child.stdin.write(JSON.stringify({...data,id})+'\n',error=>{if(error){this.pending.delete(id);cleanup();reject(error);}});
    });
  }
  read(image,{engine='paddle',language='en',variant='original',signal}={}){
    if(signal?.aborted)return Promise.reject(Error('ยกเลิก OCR'));
    if(!this.batchEnabled)return this.request({image:Buffer.from(image).toString('base64'),engine,language,variant},{signal});
    return new Promise((resolve,reject)=>{
      const abort=()=>this.close(Error('ยกเลิก OCR'));
      signal?.addEventListener('abort',abort,{once:true});
      this.readQueue.push({image,engine,language,variant,signal,resolve,reject,cleanup:()=>signal?.removeEventListener('abort',abort)});
      if(!this.batchTimer)this.batchTimer=setTimeout(()=>this.flushReads(),8);
    });
  }
  async readBatch(items,{signal}={}){
    if(!Array.isArray(items)||items.length<1||items.length>8)throw Error('OCR batch must contain 1-8 crops');
    const {engine='paddle',language='en'}=items[0];
    if(items.some(r=>(r.engine||'paddle')!==engine||(r.language||'en')!==language))throw Error('OCR batch must use one engine and language');
    const result=await this.request({op:'recognize-batch',engine,language,items:items.map(r=>({...r,image:Buffer.from(r.image).toString('base64')}))},{signal});
    if(!Array.isArray(result)||result.length!==items.length)throw Error('Recognition batch returned an incomplete result');
    return result;
  }
  flushReads(){
    this.batchTimer=null;
    const queue=this.readQueue.splice(0);
    while(queue.length){
      const first=queue.shift(),group=[first];
      // Two region crops at a time keeps VRAM bounded alongside a local AI model.
      const next=queue.findIndex(r=>r.engine===first.engine&&r.language===first.language&&r.signal===first.signal);
      if(next>=0)group.push(queue.splice(next,1)[0]);
      this.readBatch(group.map(({image,engine,language,variant})=>({image,engine,language,variant})),{signal:first.signal})
        .then(results=>group.forEach((r,i)=>r.resolve(results[i])),error=>group.forEach(r=>r.reject(error)))
        .finally(()=>group.forEach(r=>r.cleanup()));
    }
  }
  detect(image,{variant='original',signal}={}){return this.request({op:'detect',image:Buffer.from(image).toString('base64'),variant},{signal});}
  preview(image,{variant='original',signal}={}){return this.request({op:'preview',image:Buffer.from(image).toString('base64'),variant},{signal});}
  layout(image,regions,{signal}={}){return this.request({op:'layout',image:Buffer.from(image).toString('base64'),regions},{signal});}
  layoutSafe(image,regions,{signal,includeSplitHints=true}={}){return this.request({op:'layout-safe',image:Buffer.from(image).toString('base64'),regions,includeSplitHints},{signal});}
  async status(){const status=await this.request({op:'status'});this.batchEnabled=Boolean(status.capabilities?.batch);return status;}
  close(error=Error('Local OCR worker closed')){clearTimeout(this.batchTimer);this.batchTimer=null;for(const r of this.readQueue.splice(0)){r.cleanup();r.reject(error);}const child=this.child;this.child=null;for(const p of this.pending.values()){p.cleanup();p.reject(error);}this.pending.clear();child?.kill();}
}
module.exports={LocalOcrBackend,runtimeRoot};
