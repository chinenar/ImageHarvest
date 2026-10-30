'use strict';
const $=id=>document.getElementById(id),api=window.ocrLab;
let pages=[],currentId='',selectedId='',scale=1,image=null,drawing=false,drag=null,busy=false,metricRevision=0,cancelRequested=false;
const current=()=>pages.find(p=>p.id===currentId);
const layer=()=>$('layer').value;
const activeRun=()=>current()?.runs[current()?.activeRun??(current()?.runs.length-1)];
const rows=()=>layer()==='rawRegions'&&$('pass').value!=='combined' ? activeRun()?.passes?.find(p=>p.name===$('pass').value)?.regions||[] : current()?.[layer()]||[];
const selected=()=>rows().find(r=>r.id===selectedId);
const clone=x=>structuredClone(x);
const uid=()=>crypto.randomUUID();
const translationToolbar=document.createElement('div');translationToolbar.className='translation-toolbar';
translationToolbar.innerHTML='<b>แปลข้อความ</b><select id="translateProvider" aria-label="ผู้ให้บริการแปล"><option value="google">Google Translate</option><option value="ai">AI ในเครื่อง</option></select><select id="translateSource" aria-label="ภาษาต้นฉบับ"><option value="auto">ตรวจภาษาอัตโนมัติ</option><option value="ja">ญี่ปุ่น</option><option value="en">อังกฤษ</option><option value="th">ไทย</option><option value="fr">ฝรั่งเศส</option></select><span>→</span><select id="translateTarget" aria-label="ภาษาคำแปล"><option value="th">ไทย</option><option value="en">อังกฤษ</option><option value="ja">ญี่ปุ่น</option><option value="fr">ฝรั่งเศส</option></select><label><input id="translateReviewed" type="checkbox"> เฉพาะกรอบที่ตรวจแล้ว</label><button id="translatePage" class="primary">แปลภาพนี้</button><button id="translateSelected">แปลกรอบที่เลือก</button><details class="translation-context"><summary>บริบทสำหรับ AI</summary><textarea id="translateContext" rows="2" maxlength="12000" aria-label="บริบทสำหรับ AI" placeholder="เรื่องย่อ ชื่อตัวละคร ความสัมพันธ์"></textarea></details>';
document.querySelector('.canvas-toolbar').after(translationToolbar);
const overlayButton=document.createElement('button');overlayButton.id='showOnWeb';overlayButton.textContent='วางคำแปลบนเว็บต้นทาง';$('translateSelected').after(overlayButton);
overlayButton.onclick=()=>guarded(async()=>{const p=current();if(!p||busy)return;setBusy(true);try{const result=await api.overlay({id:p.id,regions:p.regions,targetLanguage:$('translateTarget').value});status(`วางคำแปลบนเว็บแล้ว ${result.drawn}/${result.total} จุด • สลับดูต้นฉบับได้บนแท็บเว็บ`);}finally{setBusy(false);}});
const uncertainLabel=document.createElement('label');uncertainLabel.innerHTML='<input id="translateUncertain" type="checkbox"> แปลกรอบความมั่นใจต่ำด้วย';$('translateReviewed').parentElement.after(uncertainLabel);
for(const [value,label]of [['watermark','ลายน้ำ / เครดิต (ไม่แปล)'],['non-text','ภาพที่ไม่ใช่ข้อความ (ไม่แปล)'],['sfx','เอฟเฟกต์เสียง (เก็บต้นฉบับ ไม่แปล)']]){const o=document.createElement('option');o.value=value;o.textContent=label;$('kind').append(o);}
const modelSelect=document.createElement('select');modelSelect.id='translateModel';modelSelect.setAttribute('aria-label','โมเดล AI');modelSelect.hidden=true;
const automaticModel=document.createElement('option');automaticModel.value='';automaticModel.textContent='เลือกโมเดลอัตโนมัติ';modelSelect.append(automaticModel);
const refreshModels=document.createElement('button');refreshModels.id='refreshModels';refreshModels.textContent='โหลดรายชื่อโมเดล';refreshModels.hidden=true;
$('translateProvider').after(modelSelect,refreshModels);
$('translateProvider').onchange=()=>{modelSelect.hidden=refreshModels.hidden=$('translateProvider').value!=='ai';};
refreshModels.onclick=()=>guarded(async()=>{refreshModels.disabled=true;try{const result=await api['translation-models']();modelSelect.replaceChildren(...result.models.map(id=>{const option=document.createElement('option');option.value=id;option.textContent=id;return option;}));modelSelect.value=result.preferred;status(`AI พบ ${result.models.length} โมเดลสำหรับแปล • เลือกโมเดลที่ต้องการได้`);}finally{refreshModels.disabled=busy;}});
const translationEditor=document.createElement('section');translationEditor.className='translation-editor';
translationEditor.innerHTML='<h2>คำแปล</h2><textarea id="translationText" rows="4" readonly aria-label="คำแปล" placeholder="เลือกกรอบแล้วกดแปล"></textarea><p id="translationMeta" class="hint"></p>';
$('text').after(translationEditor);
function translationCurrent(r){const t=r?.translationRecord;return Boolean(t&&t.sourceText===r.text&&JSON.stringify(t.bbox)===JSON.stringify(r.bbox));}
function renderTranslation(r){$('translationText').value=r?.translation||'';const t=r?.translationRecord;$('translationMeta').textContent=t?`${t.provider==='ai'?'AI • '+t.model:'Google Translate'} • ${t.sourceLanguage} → ${t.targetLanguage}${!translationCurrent(r)?' • ต้นฉบับหรือกรอบเปลี่ยนแล้ว ต้องแปลใหม่':t.status==='failed'?' • '+t.error:''}${t.sourceReviewRequired?' • ต้นฉบับยังต้องตรวจ OCR':''}`:'';}
const scaleSelect=document.createElement('select');scaleSelect.id='imageScale';scaleSelect.setAttribute('aria-label','ขยายภาพก่อน OCR');
for(const n of [1,2,3]){const option=document.createElement('option');option.value=n;option.textContent=`OCR ${n}×`;scaleSelect.append(option);}
$('mode').after(scaleSelect);
const engineSelect=document.createElement('select');engineSelect.id='engine';engineSelect.setAttribute('aria-label','เอนจิน OCR');
for(const [value,label]of [['enhanced','ใหม่: Manga OCR / PaddleOCR'],['baseline','ฐานเดิม: Tesseract']]){const o=document.createElement('option');o.value=value;o.textContent=label;engineSelect.append(o);}
scaleSelect.after(engineSelect);
const preprocessingSelect=document.createElement('select');preprocessingSelect.id='preprocessing';preprocessingSelect.setAttribute('aria-label','การอ่านซ้ำ');
for(const [value,label]of [['auto','อ่านซ้ำเมื่อไม่ชัด'],['all','เทียบภาพทุกแบบ (ช้ากว่า)']]){const o=document.createElement('option');o.value=value;o.textContent=label;preprocessingSelect.append(o);}
engineSelect.after(preprocessingSelect);engineSelect.onchange=()=>{preprocessingSelect.disabled=busy||engineSelect.value==='baseline';};
const cacheLabel=document.createElement('label');cacheLabel.innerHTML='<input id="useOcrCache" type="checkbox" checked> ใช้ผลเดิมเมื่อภาพ/การตั้งค่าตรงกัน';preprocessingSelect.after(cacheLabel);
const variantNames={original:'ภาพเดิม',grayscale:'ระดับเทา',contrast:'ระดับเทา + คอนทราสต์',invert:'กลับดำ–ขาว',clahe:'คอนทราสต์เฉพาะบริเวณ',adaptive:'ขาวดำตามพื้นที่',otsu:'ขาวดำอัตโนมัติ','original-recrop':'ภาพเดิม ปรับกรอบ/ขนาด'};
const runSelect=document.createElement('select');runSelect.id='runHistory';runSelect.setAttribute('aria-label','ประวัติ OCR');
const viewRun=document.createElement('button');viewRun.id='viewRun';viewRun.textContent='ดูผลดิบรอบนี้';
$('layer').after(runSelect,viewRun);
const passSelect=document.createElement('select');passSelect.id='pass';passSelect.setAttribute('aria-label','รอบ OCR ดิบ');passSelect.hidden=true;
const usePass=document.createElement('button');usePass.id='usePass';usePass.textContent='ใช้ผลรอบนี้เป็นผลที่ตรวจ';usePass.hidden=true;
$('layer').after(passSelect,usePass);
function renderPasses(){passSelect.replaceChildren(...[{name:'combined'},...(activeRun()?.passes||[])].map(p=>{const o=document.createElement('option');o.value=p.name;o.textContent=p.name==='combined'?'ผล OCR ที่เลือก':`รอบ ${p.name} (${p.regions.length})`;return o;}));runSelect.replaceChildren(...(current()?.runs||[]).map((r,i)=>{const o=document.createElement('option');o.value=i;const acceleration=r.performance?.acceleration;o.textContent=`${i+1}. ${r.appVersion?'v'+r.appVersion:'ไม่ทราบรุ่น'} • ${r.engine||'OCR'}${acceleration?' • '+(acceleration.engine==='cuda'?'GPU':acceleration.fallbackReason?'CPU (หน่วยความจำ GPU ไม่พอ)':'CPU'):''} • ${r.cacheHit?'ใช้ผลเดิม':Math.round((r.ms||0)/1000)+'s'}`;return o;}));runSelect.value=current()?.activeRun??((current()?.runs.length||0)-1);}
function status(text){$('status').textContent=text;}
function history(action){const p=current();if(p)p.history.push({at:new Date().toISOString(),action});}
function edited(){const p=current();if(p&&layer()==='truth'){p.complete=false;$('complete').checked=false;}}
function setBusy(value){busy=value;for(const id of ['run','runAll','roi','import','folder','load','clipboard','capture','harvest','draw','apply','splitX','splitY','remove','copyTruth','save','layer','pages','engine','preprocessing','imageScale','mode','jpn','eng','fra','tha','runHistory','viewRun','translatePage','translateSelected','showOnWeb','translateProvider','translateSource','translateTarget','translateReviewed','translateContext','translateModel','refreshModels','useOcrCache','translateUncertain']){const el=$(id);el.disabled=value;if(id==='pages')el.style.pointerEvents=value?'none':'';}$('cancel').hidden=!value;$('preprocessing').disabled=value||engineSelect.value==='baseline';if(value)document.querySelectorAll('#alternatives button').forEach(b=>b.disabled=true);else if(selected())renderEditor();}
async function guarded(fn){try{await fn();}catch(error){status(error.message||String(error));}}
function addPages(incoming){for(const p of incoming)pages.push({...p,regions:p.regions||[],rawRegions:p.rawRegions||[],truth:p.truth||[],complete:Boolean(p.complete),history:p.history||[],runs:p.runs||[]});if(incoming.length)selectPage(incoming[0].id);renderPages();}
function renderPages(){
 $('pageCount').textContent=pages.length;
 $('pages').replaceChildren(...pages.map(p=>{const b=document.createElement('button');b.className='page-button'+(p.id===currentId?' active':'');b.textContent=p.name;const small=document.createElement('small');small.textContent=`${p.width}×${p.height} • OCR ${p.regions.length} / เฉลย ${p.truth.length}`;b.append(small);b.onclick=()=>{if(!busy)selectPage(p.id);};return b;}));
}
async function selectPage(id){
 currentId=id;selectedId='';drawing=false;$('draw').textContent='＋ วาดกรอบ';const p=current();
 image=new Image();const loading=image;image.src=p.dataUrl;await image.decode();if(image!==loading)return;
 $('empty').hidden=true;$('canvas').hidden=false;$('complete').checked=p.complete;renderPasses();fit();renderPages();renderList();renderEditor();measure();
 $('complete').disabled=p.measurementScope==='recognition-only';
}
function fit(){if(!current())return;scale=Math.min(1,Math.max(.05,($('viewport').clientWidth-32)/current().width));paint();}
function paint(){
 const p=current();if(!p||!image)return;const canvas=$('canvas');
 // Keep the bitmap within browser limits. CSS zoom still exposes the full
 // original page and pointer coordinates continue to use the display scale.
 const rasterScale=Math.min(scale,4096/p.width,16384/p.height,Math.sqrt(16000000/(p.width*p.height)));
 canvas.width=Math.max(1,Math.round(p.width*rasterScale));canvas.height=Math.max(1,Math.round(p.height*rasterScale));
 canvas.style.width=Math.round(p.width*scale)+'px';canvas.style.height=Math.round(p.height*scale)+'px';$('zoomValue').textContent=Math.round(scale*100)+'%';
 const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0,canvas.width,canvas.height);
 ctx.scale(rasterScale/scale,rasterScale/scale);
 function box(r,index,color,dashed=false){const b=r.bbox;ctx.strokeStyle=color;ctx.lineWidth=r.id===selectedId?3:1.5;ctx.setLineDash(dashed?[5,3]:[]);if($('showLineBoxes').checked){for(const a of window.ocrDisplayGeometry.displayBoxes(r))ctx.strokeRect(a.x0*scale,a.y0*scale,(a.x1-a.x0)*scale,(a.y1-a.y0)*scale);}else{const points=window.ocrDisplayGeometry.outline(r);ctx.beginPath();points.forEach(([x,y],i)=>i?ctx.lineTo(x*scale,y*scale):ctx.moveTo(x*scale,y*scale));ctx.closePath();ctx.stroke();}ctx.setLineDash([]);ctx.fillStyle=color;ctx.font='bold 12px Segoe UI';const text=String(index+1);const w=ctx.measureText(text).width+10;const y=Math.max(0,b.y0*scale-18);ctx.fillRect(b.x0*scale,y,w,18);ctx.fillStyle='#0b0d15';ctx.fillText(text,b.x0*scale+5,y+13);}
 if($('showBoxes').checked){if($('showTruth').checked&&layer()!=='truth')p.truth.forEach((r,i)=>box(r,i,'#75e2b7',true));rows().forEach((r,i)=>box(r,i,layer()==='truth'?'#75e2b7':r.contentRole?.role==='watermark'||['non-text','sfx'].includes(r.kind)?'#9196a2':r.reviewRequired&&!r.reviewed?'#ff86b2':'#b997ff'));}
 if(drag){ctx.strokeStyle='#ffdb8b';ctx.lineWidth=2;ctx.setLineDash([5,3]);ctx.strokeRect(drag.x*scale,drag.y*scale,(drag.endX-drag.x)*scale,(drag.endY-drag.y)*scale);ctx.setLineDash([]);}
}
function renderList(){
 $('regionHeading').textContent=`${layer()==='truth'?'เฉลยอ้างอิง':layer()==='rawRegions'?'OCR ดิบ':'ชุดข้อความ'} (${rows().length})`;
 $('regions').replaceChildren(...rows().map((r,i)=>{const b=document.createElement('button');b.className='region-button'+(r.id===selectedId?' active':'')+(layer()==='truth'?' truth':r.reviewRequired&&!r.reviewed?' review':'');b.textContent=`${i+1}. ${r.text||'ยังไม่มีข้อความ'}`;const small=document.createElement('small');small.textContent=`${r.orientation==='vertical'?'แนวตั้ง':'แนวนอน'} • ${r.confidence==null?'ไม่มีคะแนนความมั่นใจ':`confidence ${r.confidence}%`}${r.contentRole?.role==='watermark'?' • ลายน้ำ: ไม่แปล':r.kind==='sfx'?' • เอฟเฟกต์เสียง: เก็บต้นฉบับ':r.kind==='non-text'?' • ไม่ใช่ข้อความ: ไม่แปล':['shared-ink-needs-review','source-shape-needs-review'].includes(r.contentRole?.reason)?' • ขอบเขตหมึกยังแยกไม่ชัด: ยังไม่ลบพื้นหลัง':r.contentRole?.reason==='overlapping-readings-need-review'?' • กรอบข้อความทับกัน: ตรวจขอบเขตก่อนแปล':r.contentRole?.reason==='script-conflict-needs-review'?' • คำอ่านต่างภาษาขัดกัน: ตรวจตัวเลือกก่อนแปล':r.contentRole?.reason==='incomplete-japanese-reading-needs-review'?' • อ่านได้บางส่วน: ตรวจข้อความที่เหลือก่อนแปล':r.contentRole?.reason==='sparse-fragment-reading-needs-review'?' • ตัวเขียนเล็ก: ต้องตรวจคำอ่าน':r.contentRole?.reason==='possible-sound-effect-needs-review'?' • อาจเป็นเอฟเฟกต์: ตรวจชนิดข้อความก่อนแปล':r.contentRole?.role==='uncertain'?' • รอตรวจ: ยังไม่ส่งแปล':''}${r.reviewed?' • ตรวจแล้ว':''}${r.translation?' • แปลแล้ว':''}${r.translationRecord&&!translationCurrent(r)?' • ต้องแปลใหม่':''}`;b.append(small);b.onclick=()=>selectRegion(r.id,true);return b;}));paint();
}
function selectRegion(id,scroll=false){selectedId=id;renderList();renderEditor();if(scroll){const b=selected()?.bbox;if(b)$('viewport').scrollTo({left:Math.max(0,b.x0*scale-40),top:Math.max(0,b.y0*scale-40)});}}
function renderEditor(){overlayButton.disabled=busy||!['harvest','screenshot'].includes(current()?.source?.type);overlayButton.title='ใช้กับผล Harvest ล่าสุด หรือภาพแคปแท็บ HarvestTS';const r=selected();$('editor').hidden=!r;if(!r)return;renderTranslation(r);const readonly=layer()==='rawRegions';$('selectedTitle').textContent='กรอบ '+(rows().indexOf(r)+1);$('text').value=r.text||'';$('orientation').value=r.orientation||'horizontal';$('kind').value=r.contentRole?.role==='watermark'&&!r.contentOverride?'watermark':r.kind||'text';$('x0').value=r.bbox.x0;$('y0').value=r.bbox.y0;$('boxWidth').value=r.bbox.x1-r.bbox.x0;$('boxHeight').value=r.bbox.y1-r.bbox.y0;$('reviewed').checked=Boolean(r.reviewed);$('regionMeta').textContent=`ID ${r.id}${r.origin==='manual-split'?' • แยกกรอบด้วยมือ':r.origin==='manual'?' • วาดกรอบด้วยมือ':r.origin==='roi'?' • OCR เฉพาะกรอบ':''}${r.observedBy?' • '+r.observedBy.join(', '):''}${r.disagreement?' • คำอ่านขัดกัน ต้องตรวจ':''}${r.conflicts?.length?' • กรอบซ้อนทับ ต้องตรวจ':''}`;for(const id of ['apply','roi','splitX','splitY','remove'])$(id).disabled=readonly||busy;
 $('alternatives').replaceChildren(...(r.alternatives||[]).map(a=>{const section=document.createElement('details'),title=document.createElement('summary'),text=document.createElement('pre');title.textContent=`${a.engine||'OCR'} / ${variantNames[a.variant]||a.variant||'baseline'} • ${a.confidence==null?'ไม่มีคะแนนความมั่นใจ':Math.round(a.confidence)+'%'}${a.error?' • อ่านไม่สำเร็จ':''}`;text.textContent=a.error||a.text;section.append(title,text);if(a.crop&&!a.error){const preview=document.createElement('button');preview.textContent='ดูภาพที่ใช้ OCR';preview.disabled=busy;const pageId=current().id;preview.onclick=()=>guarded(async()=>{preview.disabled=true;try{const result=await api.preview({id:pageId,crop:a.crop,variant:a.variant});let img=section.querySelector('img');if(!img){img=document.createElement('img');img.className='ocr-preview';img.alt='ภาพที่ใช้ OCR: '+(variantNames[a.variant]||a.variant);section.append(img);}img.src=result.dataUrl;}finally{preview.disabled=busy;}});section.append(preview);}if(!readonly&&layer()!=='truth'){const use=document.createElement('button');use.textContent='ใช้คำอ่านนี้';use.disabled=busy||Boolean(a.error);use.onclick=()=>{r.text=a.text;r.confidence=a.confidence;r.recognitionEngine=a.engine;r.recognitionModel=a.model;r.recognitionLines=clone(a.textLines||a.recognitionLines||[]);r.words=[];r.selectionReason='manual-alternative';r.reviewed=false;r.reviewRequired=true;history('choose-reading-'+r.id);renderList();renderEditor();measure();};section.append(use);}return section;}));
}
async function measure(){
 const p=current();if(!p)return;const rev=++metricRevision;const m=await api.evaluate({regions:layer()==='rawRegions'?rows():p.regions,truth:p.truth,complete:p.complete});if(rev!==metricRevision)return;
 if(p.measurementScope==='recognition-only'){
  const note=document.createElement('small');note.textContent='เฉลยเฉพาะคำอ่านในกรอบทดสอบ • ยังไม่วัดความครบหรือตำแหน่งทั้งภาพ';
  const value=document.createElement('b');value.textContent=m.characterAccuracy===null?'กรอบอ้างอิงไม่มีข้อความ':`ตัวอักษรถูก ${(m.characterAccuracy*100).toFixed(1)}%`;
  $('metrics').replaceChildren(value,note);p.metrics=m;return;
 }
 const container=$('metrics');container.replaceChildren();if(!p.truth.length){container.textContent='ยังไม่มีเฉลยอ้างอิง จึงยังวัดความครบไม่ได้';return;}
 for(const [label,value] of [['พบชุดข้อความ',m.recall],['กรอบที่พบถูกต้อง',m.precision],['ตัวอักษรถูก',m.characterAccuracy],['ตำแหน่งตรง ≥80% IoU',m.locationRecall]]){const el=document.createElement('div');el.className='metric';const b=document.createElement('b');b.textContent=value===null?'—':(value*100).toFixed(1)+'%';const small=document.createElement('small');small.textContent=label;el.append(b,small);container.append(el);}
 const flag=document.createElement('span');flag.className='badge'+(m.targetMet?'':' pending');flag.textContent=m.targetMet?'ผ่านเป้าหมาย 99%':!p.complete?'เฉลยยังไม่ยืนยันครบ':'ยังไม่ผ่าน 99%';container.append(flag);
 const note=document.createElement('small');note.textContent=`ตกหล่น ${m.missing.length} • เกิน ${m.extra.length} • รวมผิด ${m.merges.length} • แยก/ซ้ำ ${m.splits.length}`;container.append(note);p.metrics=m;
}
async function runPage(p,bbox){
 const languages=['jpn','eng','fra','tha'].filter(x=>$(x).checked);const result=await api.run({id:p.id,languages,mode:$('mode').value,bbox,imageScale:Number(scaleSelect.value),engine:engineSelect.value,preprocessing:preprocessingSelect.value,useCache:$('useOcrCache').checked});p.runs.push({...result,regions:clone(result.regions)});p.activeRun=p.runs.length-1;return result;
}
async function runAll(all){
 if(!current()||busy)return;setBusy(true);cancelRequested=false;
 try{for(const p of all?pages:[current()]){if(cancelRequested)break;const result=await runPage(p);p.rawRegions=clone(result.regions);p.regions=clone(result.regions);p.history.push({at:new Date().toISOString(),action:'ocr-full'});if(p.id===currentId){selectedId='';$('complete').checked=p.complete;renderPasses();renderList();renderEditor();await measure();}renderPages();}status(cancelRequested?'หยุด OCR แล้ว':'OCR เสร็จแล้ว • ตรวจกรอบสีชมพูและข้อความที่ตกหล่น');}finally{setBusy(false);renderEditor();}
}
async function translatePage(onlySelected=false){
 const p=current();if(!p||busy)return;
 if(layer()!=='regions')throw Error('เลือกชั้นผล OCR ที่ตรวจก่อนแปล');
 const source=(onlySelected?[selected()].filter(Boolean):p.regions).filter(r=>r.text?.trim()&&(!$('translateReviewed').checked||r.reviewed));
 if(!source.length)throw Error('ไม่มีข้อความที่เลือกให้แปล');
 setBusy(true);cancelRequested=false;status(`กำลังส่ง ${source.length} กรอบไปแปล…`);
 try{
   const result=await api.translate({id:p.id,regions:clone(source),provider:$('translateProvider').value,sourceLanguage:$('translateSource').value,targetLanguage:$('translateTarget').value,context:$('translateContext').value,includeUncertain:$('translateUncertain').checked,model:$('translateProvider').value==='ai'?$('translateModel').value:''});
   p.translationRuns??=[];p.translationRuns.push(clone(result));
   const byId=new Map(result.items.map(item=>[item.id,item]));
   for(const r of p.regions){const t=byId.get(r.id);if(t){r.translation=t.translation;r.translationProvider=result.provider;r.translationRecord=clone(t);}}
   for(const skipped of result.skipped||[]){const r=p.regions.find(r=>r.id===skipped.id);if(r){r.contentRole=clone(skipped);delete r.translation;delete r.translationRecord;}}
   history('translate-'+result.provider);renderList();renderEditor();
   status(`${result.provider==='ai'?'AI':'Google Translate'} แปลแล้ว ${result.translated}/${result.total} กรอบ${result.failed?' • ไม่สำเร็จ '+result.failed+' กรอบ':''}${result.skipped?.length?' • ข้ามลายน้ำ/กรอบรอตรวจ '+result.skipped.length+' กรอบ':''} • เลือกกรอบเพื่อดูต้นฉบับและคำแปล`);
 }finally{setBusy(false);renderEditor();}
}
$('translatePage').onclick=()=>guarded(()=>translatePage());$('translateSelected').onclick=()=>guarded(()=>translatePage(true));
function point(event){const rect=$('canvas').getBoundingClientRect();return {x:Math.max(0,Math.min(current().width,(event.clientX-rect.left)/scale)),y:Math.max(0,Math.min(current().height,(event.clientY-rect.top)/scale))};}
$('canvas').addEventListener('pointerdown',event=>{
 if(busy||!current()||event.button!==0)return;const {x,y}=point(event);
 if(drawing&&layer()!=='rawRegions'){drag={x,y,endX:x,endY:y};$('canvas').setPointerCapture(event.pointerId);}
 else{const hits=rows().filter(r=>($('showLineBoxes').checked?window.ocrDisplayGeometry.displayBoxes(r).some(a=>x>=a.x0&&x<=a.x1&&y>=a.y0&&y<=a.y1):window.ocrDisplayGeometry.contains(r,x,y))).sort((a,b)=>(a.bbox.x1-a.bbox.x0)*(a.bbox.y1-a.bbox.y0)-(b.bbox.x1-b.bbox.x0)*(b.bbox.y1-b.bbox.y0));if(hits.length)selectRegion(hits[(hits.findIndex(r=>r.id===selectedId)+1)%hits.length].id);}
});
$('canvas').addEventListener('pointermove',event=>{if(!drag)return;const {x,y}=point(event);drag.endX=x;drag.endY=y;paint();});
$('canvas').addEventListener('pointerup',()=>{
 if(!drag)return;const d=drag;drag=null;const bbox={x0:Math.round(Math.min(d.x,d.endX)),y0:Math.round(Math.min(d.y,d.endY)),x1:Math.round(Math.max(d.x,d.endX)),y1:Math.round(Math.max(d.y,d.endY))};
 if(bbox.x1-bbox.x0>3&&bbox.y1-bbox.y0>3){const r={id:uid(),text:'',bbox,orientation:'horizontal',kind:'text',reviewRequired:true,origin:'manual'};rows().push(r);edited();history('add-'+layer());selectRegion(r.id);measure();renderPages();}paint();
});
$('canvas').addEventListener('pointercancel',()=>{drag=null;paint();});
$('apply').onclick=()=>guarded(async()=>{
 const r=selected(),p=current();if(!r||layer()==='rawRegions')return;
 const x0=Number($('x0').value),y0=Number($('y0').value),w=Number($('boxWidth').value),h=Number($('boxHeight').value);
 if(![x0,y0,w,h].every(Number.isFinite)||x0<0||y0<0||w<=0||h<=0||x0+w>p.width||y0+h>p.height)throw Error('กรอบต้องอยู่ภายในภาพ');
 Object.assign(r,{text:$('text').value,bbox:{x0,y0,x1:x0+w,y1:y0+h},orientation:$('orientation').value,kind:$('kind').value,reviewed:$('reviewed').checked});r.contentOverride=!['watermark','non-text','sfx'].includes(r.kind);r.contentRole={role:r.contentOverride?'content':r.kind,excluded:!r.contentOverride,reason:'manual'};if(!r.contentOverride){delete r.translation;delete r.translationRecord;}edited();history('edit-'+r.id);renderList();renderEditor();await measure();
});
function split(axis){const r=selected();if(!r||layer()==='rawRegions'||busy)return;const a=clone(r.bbox),b=clone(a);if(axis==='x'){const mid=Math.round((a.x0+a.x1)/2);a.x1=mid;b.x0=mid;}else{const mid=Math.round((a.y0+a.y1)/2);a.y1=mid;b.y0=mid;}if(a.x1<=a.x0||a.y1<=a.y0||b.x1<=b.x0||b.y1<=b.y0)return;const list=rows();const i=list.indexOf(r);list.splice(i,1,...[a,b].map(bbox=>({...r,id:uid(),parentId:r.id,bbox,text:'',translation:'',reviewed:false,reviewRequired:true,origin:'manual-split'})));edited();history('split-'+r.id);selectRegion(list[i].id);measure();renderPages();status('แยกกรอบแล้ว • OCR ใหม่ทีละกรอบหรือใส่ข้อความอ้างอิง');}
$('splitX').onclick=()=>split('x');$('splitY').onclick=()=>split('y');
$('roi').onclick=()=>guarded(async()=>{const r=selected(),p=current();if(!r||busy||layer()==='rawRegions')return;if(layer()==='truth')throw Error('OCR ใหม่ใช้กับผล OCR เท่านั้น เฉลยต้องตรวจจากภาพ');setBusy(true);try{const result=await runPage(p,r.bbox);if(!result.regions.length){status('ไม่พบข้อความในกรอบนี้ • เก็บกรอบเดิมไว้');return;}const i=p.regions.indexOf(r);p.regions.splice(i,1,...result.regions.map(item=>({...item,id:uid(),parentId:r.id,origin:'roi'})));edited();history('roi-'+r.id);selectedId=p.regions[i].id;renderList();renderEditor();renderPages();await measure();}finally{setBusy(false);renderEditor();}});
$('remove').onclick=()=>{const r=selected();if(!r||busy||layer()==='rawRegions')return;rows().splice(rows().indexOf(r),1);edited();history('remove-'+r.id);selectedId='';renderList();renderEditor();measure();renderPages();};
$('copyTruth').onclick=()=>{if(!current()||busy)return;if(current().truth.length){status('มีเฉลยอยู่แล้ว • วาดเพิ่มหรือแก้ไขในชั้นเฉลยอ้างอิง');return;}current().truth=current().regions.map(r=>({...clone(r),id:uid(),origin:'ocr-draft',reviewed:false}));edited();history('truth-draft');$('layer').value='truth';selectedId='';renderList();renderEditor();measure();renderPages();};
$('complete').onchange=()=>guarded(async()=>{if(!current())return;if($('complete').checked&&current().truth.some(r=>!r.text.trim()||!r.reviewed)){$('complete').checked=false;throw Error('ตรวจข้อความและกรอบเฉลยทุกชุด และติ๊กตรวจแล้วก่อนยืนยัน');}current().complete=$('complete').checked;history('truth-complete-'+current().complete);await measure();});
$('layer').onchange=()=>{selectedId='';drawing=false;$('draw').textContent='＋ วาดกรอบ';$('draw').disabled=layer()==='rawRegions'||busy;passSelect.hidden=usePass.hidden=layer()!=='rawRegions';renderList();renderEditor();measure();};
viewRun.onclick=()=>{const p=current(),run=p?.runs[Number(runSelect.value)];if(!run||busy)return;p.activeRun=Number(runSelect.value);p.rawRegions=clone(run.regions);$('layer').value='rawRegions';renderPasses();$('layer').onchange();};
passSelect.onchange=()=>{selectedId='';renderList();renderEditor();measure();};
usePass.onclick=()=>{if(!current()||busy)return;current().regions=clone(rows()).map(r=>({...r,reviewed:false}));edited();history('select-pass-'+passSelect.value);$('layer').value='regions';$('layer').onchange();renderPages();};
$('draw').onclick=()=>{if(!current()||layer()==='rawRegions')return;drawing=!drawing;$('draw').textContent=drawing?'วาดบนภาพได้เลย ✓':'＋ วาดกรอบ';};
$('run').onclick=()=>guarded(()=>runAll(false));$('runAll').onclick=()=>guarded(()=>runAll(true));$('cancel').onclick=()=>guarded(async()=>{cancelRequested=true;await api.cancel();status('กำลังหยุด OCR / การแปล');});
for(const name of ['import','folder','clipboard','capture','harvest'])$(name).onclick=()=>guarded(async()=>{if(busy)return;const incoming=await api[name]();addPages(incoming);status(incoming.length?`นำเข้า ${incoming.length} ภาพแล้ว`:'ไม่มีภาพใหม่');});
$('save').onclick=()=>guarded(async()=>{if(!pages.length)throw Error('ยังไม่มีภาพ');const file=await api.save({pages});if(file)status('บันทึกแล้ว: '+file);});
$('load').onclick=()=>guarded(async()=>{const incoming=await api.load();addPages(incoming);status(`เปิด ${incoming.length} ภาพจากโปรเจกต์`);});
$('zoomIn').onclick=()=>{scale=Math.min(4,scale*1.2);paint();};$('zoomOut').onclick=()=>{scale=Math.max(.05,scale/1.2);paint();};$('fit').onclick=fit;$('showTruth').onchange=paint;$('showBoxes').onchange=paint;$('showLineBoxes').onchange=paint;
api.onProgress(({message})=>status(message));
document.addEventListener('paste',()=>{if(!busy)guarded(async()=>addPages(await api.clipboard()));});

guarded(async()=>{const info=await api.info();document.querySelector('.eyebrow').textContent='IMAGEHARVEST '+info.appVersion+' / OCR LAB';});
