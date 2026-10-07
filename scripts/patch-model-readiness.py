from pathlib import Path
p=Path(r"E:\Shared\ExportImagefromWeb\src\harvest-translate.cjs")
s=p.read_text(encoding="utf-8")

old="""  async nativeModelInfo(model,signal){
    if(!this.nativeModelCache||Date.now()-this.nativeModelCache.at>60000){
      let models=[];try{const body=await this.request('/api/v1/models',{signal},5000);models=Array.isArray(body.models)?body.models:[];}catch(error){if(signal?.aborted)throw error;}
      this.nativeModelCache={at:Date.now(),models};
    }
    return this.nativeModelCache.models.find(r=>r.type==='llm'&&(r.key===model||r.loaded_instances?.some(x=>x.id===model)));
  }

  async probe({ sample = false } = {}) {"""
new="""  async nativeModelInfo(model,signal,{fresh=false}={}){
    if(fresh)this.nativeModelCache=null;
    if(!this.nativeModelCache||Date.now()-this.nativeModelCache.at>5000){
      let models=[];try{const body=await this.request('/api/v1/models',{signal},5000);models=Array.isArray(body.models)?body.models:[];}catch(error){if(signal?.aborted)throw error;}
      this.nativeModelCache={at:Date.now(),models};
    }
    return this.nativeModelCache.models.find(r=>r.type==='llm'&&(r.key===model||r.loaded_instances?.some(x=>x.id===model)));
  }

  async ensureModelReady(model,{signal,onStatus,timeoutMs=8*60*1000,pollMs=1500}={}){
    const started=Date.now(),deadline=started+Math.max(30000,Number(timeoutMs)||8*60*1000);
    const check=()=>{if(signal?.aborted)throw new Error('ยกเลิกการแปลแล้ว');};
    const sleep=ms=>new Promise((resolve,reject)=>{
      if(signal?.aborted)return reject(new Error('ยกเลิกการแปลแล้ว'));
      const timer=setTimeout(done,Math.max(1,ms));
      function done(){signal?.removeEventListener?.('abort',aborted);resolve();}
      function aborted(){clearTimeout(timer);reject(new Error('ยกเลิกการแปลแล้ว'));}
      signal?.addEventListener?.('abort',aborted,{once:true});
    });
    const remaining=()=>Math.max(1000,deadline-Date.now());
    const nativeWarm=async()=>{
      const body=await this.request('/api/v1/chat',{
        method:'POST',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({
          model,input:'Reply with READY only.',system_prompt:'This is a readiness check. Reply exactly READY.',temperature:0,
          max_output_tokens:8,store:false,reasoning:'off'
        })
      },Math.min(5*60*1000,remaining()));
      const content=(body.output||[]).filter(r=>r.type==='message').map(r=>String(r.content||'')).join('\\n').trim();
      if(!body?.model_instance_id&&!content)throw new Error('โมเดลโหลดแล้วแต่ยังไม่ตอบ readiness check');
      return body;
    };
    const openAiWarm=async()=>{
      const body=await this.request('/v1/chat/completions',{
        method:'POST',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({
          model,temperature:0,max_tokens:8,messages:[
            {role:'system',content:'This is a readiness check. Reply exactly READY.'},
            {role:'user',content:'READY'}
          ]
        })
      },Math.min(5*60*1000,remaining()));
      const content=String(body?.choices?.[0]?.message?.content||'').trim();
      if(!content)throw new Error('โมเดลโหลดแล้วแต่ยังไม่ตอบ readiness check');
      return body;
    };

    check();
    let info=await this.nativeModelInfo(model,signal,{fresh:true});
    if(!info){
      onStatus?.({phase:'warming',model,elapsedMs:Date.now()-started,message:'กำลังอุ่นโมเดลก่อนเริ่มแปล…'});
      await openAiWarm();
      return {ready:true,native:false,model,parallel:1,loadMs:Date.now()-started};
    }

    let lastError='',lastTriggerAt=0;
    while(Date.now()<deadline){
      check();
      info=await this.nativeModelInfo(model,signal,{fresh:true});
      const instance=info?.loaded_instances?.find(x=>x?.id===model)||info?.loaded_instances?.[0]||null;
      if(instance){
        onStatus?.({phase:'warming',model,elapsedMs:Date.now()-started,message:'โมเดลโหลดแล้ว • กำลัง warm-up ก่อนปล่อย task…'});
        try{
          await nativeWarm();
          this.nativeModelCache=null;
          return {ready:true,native:true,model,parallel:Math.max(1,Number(instance?.config?.parallel)||1),loadMs:Date.now()-started};
        }catch(error){
          check();lastError=error?.message||String(error);
          if(!/model does not exist|loading|not loaded|ตอบช้า|timeout/i.test(lastError))throw error;
        }
      }
      if(Date.now()-lastTriggerAt>15000){
        lastTriggerAt=Date.now();
        onStatus?.({phase:'loading',model,elapsedMs:Date.now()-started,message:'กำลังโหลดโมเดลเข้า RAM/VRAM…'});
        try{
          await nativeWarm();
          this.nativeModelCache=null;
          info=await this.nativeModelInfo(model,signal,{fresh:true});
          const loaded=info?.loaded_instances?.find(x=>x?.id===model)||info?.loaded_instances?.[0]||null;
          return {ready:true,native:true,model,parallel:Math.max(1,Number(loaded?.config?.parallel)||1),loadMs:Date.now()-started};
        }catch(error){
          check();lastError=error?.message||String(error);
          if(!/model does not exist|loading|not loaded|ตอบช้า|timeout/i.test(lastError))throw error;
        }
      }
      onStatus?.({phase:'loading',model,elapsedMs:Date.now()-started,message:'รอโมเดลพร้อมจริงก่อนเริ่ม task…'});
      await sleep(Math.min(Math.max(50,Number(pollMs)||1500),remaining()));
    }
    throw new Error('โหลดโมเดลไม่เสร็จภายในเวลาที่กำหนด'+(lastError?' • '+lastError:''));
  }

  async probe({ sample = false } = {}) {"""
if old not in s: raise SystemExit("nativeModelInfo anchor missing")
s=s.replace(old,new,1)

s=s.replace("""      })},120000);""","""      })},10*60*1000);""",1)
s=s.replace("""    }, 120000);""","""    }, 10*60*1000);""",1)

p.write_text(s,encoding="utf-8")
print("patched model readiness + long local translation timeout")
