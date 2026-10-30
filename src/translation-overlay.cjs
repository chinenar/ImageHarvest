'use strict';
const {translationEligible}=require('./ocr-content-role.cjs');

function overlayPage(page,{documentUrl='',targetLanguage='th'}={}){
  const width=Number(page.width),height=Number(page.height);
  if(!(width>0&&height>0))throw Error('ไม่พบขนาดภาพสำหรับวางคำแปล');
  const box=value=>{
    if(!value||!['x0','y0','x1','y1'].every(k=>Number.isFinite(Number(value[k]))))return null;
    const b={x0:Math.max(0,Math.min(1,value.x0/width)),y0:Math.max(0,Math.min(1,value.y0/height)),x1:Math.max(0,Math.min(1,value.x1/width)),y1:Math.max(0,Math.min(1,value.y1/height))};
    return b.x1>b.x0&&b.y1>b.y0?b:null;
  };
  const eligible=(page.ocr?.regions||[]).filter(r=>translationEligible(r)&&r.translation?.trim()&&r.placement?.paintMode!=='none'&&r.translationRecord?.status==='translated'&&r.translationRecord.sourceText===r.text&&r.translationRecord.imageDigest===page.imageDigest&&['x0','y0','x1','y1'].every(k=>r.translationRecord.bbox?.[k]===r.bbox?.[k]));
  const regions=eligible.map(r=>{
    const p=r.placement||{};
    if(p.paintMode==='glyph-patch'){
      const bounds=box(r.bbox),safe=box(p.safeBox)||bounds,erase=box(p.eraseBox)||bounds;
      const patch=p.erasePatch&&box(p.erasePatch.bbox)?{...p.erasePatch,bbox:box(p.erasePatch.bbox)}:null;
      return {id:String(r.id),text:r.translation,original:r.text,bbox:bounds,eraseBox:erase,safeBox:safe,eraseBoxes:[],polygon:(p.polygon||[]).map(([x,y])=>[x/width,y/height]),rotatedTextBox:p.rotatedTextBox,surfaceType:p.surfaceType||'scene',fillColor:p.fillColor||'#ffffff',erasePatch:patch,paintMode:'glyph-patch',referenceLineHeight:p.referenceLineHeight||0,reviewRequired:Boolean(r.reviewRequired||p.reviewRequired),surfaceId:p.surfaceId||'',activeSubSurfaceId:p.activeSubSurfaceId||''};
    }
    const sub=p.subSurfaces?.find(s=>s.id===p.activeSubSurfaceId||(s.regionIds||s.sourceRegionIds||[]).map(String).includes(String(r.id)));
    const bounds=box(r.bbox);
    const sameSurface=(page.ocr?.regions||[]).filter(other=>other.placement?.surfaceId===p.surfaceId);
    // A partial translation must never erase the remaining original dialogue.
    const partial=p.sharedSurface&&sameSurface.some(other=>!eligible.includes(other));
    const erase=partial?bounds:box(sub?.eraseBox||p.eraseBox)||bounds;
    const safe=partial?bounds:box(sub?.safeBox||p.safeBox)||bounds;
    const weakSurface=p.surfaceType==='bubble'&&(p.reviewRequired||Number(p.confidence)<.85);
    if(weakSurface&&!partial){
      const tight=box({x0:r.bbox.x0-2,y0:r.bbox.y0-2,x1:r.bbox.x1+2,y1:r.bbox.y1+2});
      Object.assign(erase,tight);
    }
    const rawPolygon=weakSurface?[]:sub?.polygon||p.polygon||[];
    const polygon=rawPolygon.filter(v=>Array.isArray(v)&&v.length===2&&v.every(Number.isFinite)).map(([x,y])=>[Math.max(0,Math.min(1,x/width)),Math.max(0,Math.min(1,y/height))]);
    const surface=p.speechSurface?.eraseBox||sub?.eraseBox||p.eraseBox||r.bbox;
    const sw=Math.max(1,(Number(surface?.x1)||0)-(Number(surface?.x0)||0)),sh=Math.max(1,(Number(surface?.y1)||0)-(Number(surface?.y0)||0));
    const spill=Math.max(4,Math.min(22,Math.min(sw,sh)*.09));
    const limit={x0:(Number(surface?.x0)||0)-spill,y0:(Number(surface?.y0)||0)-spill,x1:(Number(surface?.x1)||width)+spill,y1:(Number(surface?.y1)||height)+spill};
    const rawEraseBoxes=(p.sourceEraseBoxes?.length?p.sourceEraseBoxes:(r.words||[]).map(word=>word?.bbox).filter(Boolean));
    const eraseBoxes=p.surfaceType==='bubble'?rawEraseBoxes.map(value=>{
      if(!value)return null;
      const expanded={x0:(Number(value.x0)||0)-2,y0:(Number(value.y0)||0)-2,x1:(Number(value.x1)||0)+2,y1:(Number(value.y1)||0)+2};
      const clipped={x0:Math.max(limit.x0,expanded.x0),y0:Math.max(limit.y0,expanded.y0),x1:Math.min(limit.x1,expanded.x1),y1:Math.min(limit.y1,expanded.y1)};
      return box(clipped);
    }).filter(Boolean):[];
    return {id:String(r.id),text:r.translation,original:r.text,bbox:bounds,eraseBox:erase,safeBox:safe,eraseBoxes,polygon,surfaceType:p.surfaceType||'scene',fillColor:/^#[0-9a-f]{6}$/i.test(p.fillColor)?p.fillColor:'#ffffff',reviewRequired:Boolean(r.reviewRequired||p.reviewRequired),surfaceId:p.surfaceId||'',activeSubSurfaceId:p.activeSubSurfaceId||''};
  }).filter(r=>r.bbox&&r.eraseBox&&r.safeBox);
  return {id:String(page.id),sourceUrl:page.sourceUrl,source:page.source,capture:page.capture,width,height,imageDigest:page.imageDigest,documentUrl,targetLanguage,regions,reviewCount:(page.ocr?.regions||[]).filter(r=>require('./ocr-content-role.cjs').contentRole(r).role==='uncertain').length};
}

// Self-contained: serialized into the web page without relaxing its sandbox.
function createTranslationOverlay(documentKey){
  const ID='__harvestts_translation_overlay__',NS='http://www.w3.org/2000/svg';
  document.getElementById(ID)?.remove();
  const host=document.createElement('div');host.id=ID;
  host.style.cssText='all:initial;position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483644;contain:style;';
  const root=host.attachShadow({mode:'open'}),style=document.createElement('style');
  style.textContent=':host{all:initial}*{box-sizing:border-box}.frame{position:absolute;overflow:hidden;pointer-events:none}.image{position:absolute;transform-origin:0 0}.mask{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.text{position:absolute;display:flex;align-items:center;justify-content:center;text-align:center;padding:2px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal;line-height:1.35;font-family:"Leelawadee UI","Noto Sans Thai",Tahoma,"Yu Gothic",sans-serif;font-weight:500;pointer-events:auto;cursor:text;user-select:text}.text{overflow:hidden;pointer-events:none;min-width:0;min-height:0}.text span{display:block;width:100%}.patches{position:absolute;inset:0;pointer-events:none}.patches canvas{position:absolute;pointer-events:none}.controls{display:none!important}';
  const sheet=new CSSStyleSheet();sheet.replaceSync(style.textContent);root.adoptedStyleSheets=[sheet];document.documentElement.append(host);
  const controls=document.createElement('div');controls.className='controls';controls.hidden=true;
  const toggle=document.createElement('button'),label=document.createElement('span');toggle.type='button';toggle.dataset.action='toggle-original';controls.append(toggle,label);root.append(controls);
  const pages=new Map(),entries=[];let visible=true,fontScale=1,scheduled=0,dirty=true,expectedUrl='',clipSequence=0;
  const styleOverrides=new Map();let styleRevision=0,selectedText=null,previewOriginalItem=null,saveSequence=0;
  const editCss=new CSSStyleSheet();editCss.replaceSync('.text{pointer-events:auto;cursor:pointer;touch-action:pan-y pinch-zoom}.text.selected{outline:2px solid #a996ff;outline-offset:2px;cursor:move}.resize-handle{position:absolute;width:12px;height:12px;border:2px solid #fff;background:#8d79da;border-radius:50%;box-shadow:0 0 0 1px #312a45;pointer-events:auto;touch-action:none;z-index:5}.text:not(.selected) .resize-handle{display:none}.resize-handle[data-dir="nw"]{left:0;top:0;cursor:nwse-resize}.resize-handle[data-dir="n"]{left:calc(50% - 6px);top:0;cursor:ns-resize}.resize-handle[data-dir="ne"]{right:0;top:0;cursor:nesw-resize}.resize-handle[data-dir="e"]{right:0;top:calc(50% - 6px);cursor:ew-resize}.resize-handle[data-dir="se"]{right:0;bottom:0;cursor:nwse-resize}.resize-handle[data-dir="s"]{left:calc(50% - 6px);bottom:0;cursor:ns-resize}.resize-handle[data-dir="sw"]{left:0;bottom:0;cursor:nesw-resize}.resize-handle[data-dir="w"]{left:0;top:calc(50% - 6px);cursor:ew-resize}.region-editor{position:fixed;left:12px;bottom:64px;width:320px;max-width:calc(100vw - 24px);max-height:70vh;overflow:auto;overscroll-behavior:contain;padding:14px;background:#171a24;border:1px solid #75688e;border-radius:12px;color:#eee;font:13px/1.5 "Segoe UI",Tahoma,sans-serif;pointer-events:auto;z-index:4;box-shadow:0 10px 35px #0008}.region-editor[hidden]{display:none}.editor-head{display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:move;user-select:none;touch-action:none}.region-editor button{border:1px solid #6a6085;border-radius:7px;background:#30273f;color:white;padding:6px 9px;cursor:pointer;font:inherit}.editor-label{display:block;margin:10px 0 5px;color:#aeb4c8;font-size:11px;font-weight:600}.editor-source-row{display:flex;align-items:flex-end;justify-content:space-between;gap:8px}.editor-source-row .editor-label{margin-right:auto}.editor-eye{min-width:34px;height:30px;padding:3px 8px!important;margin-bottom:3px;font-size:15px!important;line-height:1!important}.editor-eye.active{background:#51477b!important;border-color:#9b8ce8!important}.editor-original{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:9px;background:#10121a;border:1px solid #292d3d;border-radius:7px;max-height:105px;overflow:auto;user-select:text;color:#bfc5d5}.editor-text{display:block;width:100%;min-height:72px;max-height:170px;resize:vertical;margin:0;padding:9px 10px;background:#0e1119;border:1px solid #4a4262;border-radius:7px;color:#f5f3ff;font:13px/1.5 "Segoe UI",Tahoma,sans-serif;outline:none}.editor-text:focus{border-color:#907de0;box-shadow:0 0 0 2px #907de026}.editor-range{display:flex;gap:10px;align-items:center;margin:10px 0}.editor-range input{flex:1;min-width:0}.editor-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:8px}.editor-status{font-size:11px;color:#bfb5d4;margin-top:7px}.region-editor small{display:block;color:#b6afc3}.controls{z-index:3}');root.adoptedStyleSheets=[...root.adoptedStyleSheets,editCss];
  const editor=document.createElement('section');editor.className='region-editor';editor.hidden=true;editor.setAttribute('role','dialog');editor.setAttribute('aria-label','ตั้งค่าข้อความเฉพาะกล่อง');
  const editorHead=document.createElement('div');editorHead.className='editor-head';const editorTitle=document.createElement('strong');editorTitle.textContent='ตั้งค่าข้อความ • เฉพาะกล่องนี้';
  const editorClose=document.createElement('button');editorClose.type='button';editorClose.textContent='ปิด';editorHead.append(editorTitle,editorClose);
  const originalLabel=document.createElement('label');originalLabel.className='editor-label';originalLabel.textContent='ข้อความต้นฉบับ';
  const originalRow=document.createElement('div');originalRow.className='editor-source-row';
  const editorEye=document.createElement('button');editorEye.type='button';editorEye.className='editor-eye';editorEye.textContent='👁';editorEye.title='ดูต้นฉบับของกล่องนี้';editorEye.setAttribute('aria-label','ดูต้นฉบับของกล่องนี้');editorEye.setAttribute('aria-pressed','false');originalRow.append(originalLabel,editorEye);
  const editorOriginal=document.createElement('div');editorOriginal.className='editor-original';
  const translationLabel=document.createElement('label');translationLabel.className='editor-label';translationLabel.textContent='ข้อความแปล';
  const editorText=document.createElement('textarea');editorText.className='editor-text';editorText.rows=3;editorText.maxLength=10000;editorText.dataset.action='region-text';
  const fontLabel=document.createElement('label');fontLabel.className='editor-label';fontLabel.textContent='ขนาดตัวอักษร';
  const fontRow=document.createElement('div');fontRow.className='editor-range';const fontRange=document.createElement('input');fontRange.type='range';fontRange.min='6';fontRange.max='72';fontRange.step='.5';fontRange.setAttribute('aria-label','ขนาดตัวอักษรของกล่องนี้');fontRange.dataset.action='region-font-size';
  const fontValue=document.createElement('output');fontRow.append(fontRange,fontValue);
  const resetFont=document.createElement('button');resetFont.type='button';resetFont.textContent='คืนขนาดอัตโนมัติ';resetFont.dataset.action='reset-region-font';
  const resetBox=document.createElement('button');resetBox.type='button';resetBox.textContent='คืนกรอบอัตโนมัติ';resetBox.dataset.action='reset-region-box';
  const editorActions=document.createElement('div');editorActions.className='editor-actions';editorActions.append(resetFont,resetBox);
  const editorHint=document.createElement('small');editorHint.textContent='ลากหัวหน้าต่างนี้เพื่อย้าย • ลากกล่องบนภาพเพื่อย้าย • ใช้จุด 8 จุดเพื่อขยาย/ย่อ';const editorStatus=document.createElement('div');editorStatus.className='editor-status';editorStatus.setAttribute('aria-live','polite');
  editor.append(editorHead,originalRow,editorOriginal,translationLabel,editorText,fontLabel,fontRow,editorActions,editorHint,editorStatus);root.append(editor);
  let editorDrag=null;
  editorHead.addEventListener('pointerdown',e=>{if(e.button!==0||e.target===editorClose)return;const rect=editor.getBoundingClientRect();editor.style.left=rect.left+'px';editor.style.top=rect.top+'px';editor.style.bottom='auto';editorDrag={id:e.pointerId,dx:e.clientX-rect.left,dy:e.clientY-rect.top};editorHead.setPointerCapture?.(e.pointerId);e.preventDefault();e.stopPropagation();});
  editorHead.addEventListener('pointermove',e=>{if(!editorDrag||editorDrag.id!==e.pointerId)return;const rect=editor.getBoundingClientRect(),maxX=Math.max(0,innerWidth-rect.width),maxY=Math.max(0,innerHeight-rect.height),x=Math.max(0,Math.min(maxX,e.clientX-editorDrag.dx)),y=Math.max(0,Math.min(maxY,e.clientY-editorDrag.dy));editor.style.left=x+'px';editor.style.top=y+'px';editor.style.bottom='auto';e.preventDefault();e.stopPropagation();});
  const endEditorDrag=e=>{if(!editorDrag||editorDrag.id!==e.pointerId)return;editorHead.releasePointerCapture?.(e.pointerId);editorDrag=null;e.preventDefault();e.stopPropagation();};
  editorHead.addEventListener('pointerup',endEditorDrag);editorHead.addEventListener('pointercancel',endEditorDrag);
  const styleKeyFor=(page,r)=>r.styleKey||[page.imageDigest,page.targetLanguage,r.original,r.bbox.x0,r.bbox.y0,r.bbox.x1,r.bbox.y1].join('|');
  const validBox=b=>b&&['x0','y0','x1','y1'].every(k=>Number.isFinite(Number(b[k])))&&b.x0>=0&&b.y0>=0&&b.x1<=1&&b.y1<=1&&b.x1>b.x0&&b.y1>b.y0;
  const currentStyle=(page,r)=>{const k=styleKeyFor(page,r);return styleOverrides.has(k)?styleOverrides.get(k):r.userStyle||null;};
  const effectiveBox=(page,r)=>{const b=currentStyle(page,r)?.box;return validBox(b)?b:r.safeBox;};
  const effectiveText=(page,r)=>currentStyle(page,r)?.text!==undefined?String(currentStyle(page,r).text):r.text;
  const mergedStyle=(item,patch,remove=[])=>{const next={...(currentStyle(item.page,item.region)||{}),...patch};for(const key of remove)delete next[key];return Object.keys(next).length?next:null;};
  function setOriginalPreview(item,on){
    if(!item)return false;on=Boolean(on);item.previewOriginal=on;item.text.style.visibility=on?'hidden':'';
    for(const node of item.paintNodes||[])node.style.visibility=on?'hidden':'';
    if(on)previewOriginalItem=item;else if(previewOriginalItem===item)previewOriginalItem=null;
    if(selectedText===item){editorEye.classList.toggle('active',on);editorEye.setAttribute('aria-pressed',String(on));editorEye.title=on?'กลับไปดูคำแปลของกล่องนี้':'ดูต้นฉบับของกล่องนี้';editorEye.setAttribute('aria-label',editorEye.title);}
    return on;
  }
  function closeEditor(){if(previewOriginalItem)setOriginalPreview(previewOriginalItem,false);for(const e of entries)for(const t of e.texts)t.text.classList.remove('selected');selectedText=null;editor.hidden=true;editorEye.classList.remove('active');editorEye.setAttribute('aria-pressed','false');}
  function openEditor(item){closeEditor();selectedText=item;item.text.classList.add('selected');editorOriginal.textContent=item.region.original||'';editorText.value=effectiveText(item.page,item.region);fontRange.value=String(Math.max(6,Math.min(72,Number(item.text.dataset.fontSize)||12)));fontValue.textContent=fontRange.value+' px';editorStatus.textContent='';editorEye.title='ดูต้นฉบับของกล่องนี้';editorEye.setAttribute('aria-label',editorEye.title);editor.hidden=false;}
  function setRegionStyle(pageId,regionId,value){const page=pages.get(pageId),r=page?.regions.find(x=>x.id===regionId);if(!r)return false;const k=styleKeyFor(page,r);if(value===null)styleOverrides.set(k,null);else{const next={};if(value.text!==undefined){const t=String(value.text);if(t.length>10000)return false;next.text=t;}if(value.fontSizeImagePx!==undefined){const n=Number(value.fontSizeImagePx);if(!Number.isFinite(n)||n<1||n>4096)return false;next.fontSizeImagePx=n;}if(value.box!==undefined){const b={x0:Number(value.box?.x0),y0:Number(value.box?.y0),x1:Number(value.box?.x1),y1:Number(value.box?.y1)};if(!validBox(b))return false;next.box=b;}styleOverrides.set(k,Object.keys(next).length?next:null);}for(const entry of entries)for(const item of entry.texts)if(item.page===page&&item.region===r){item.span.textContent=effectiveText(page,r);item.text.title=(r.original||'')+'\n────────\n'+effectiveText(page,r);entry.lastSize='';}styleRevision++;refresh();return true;}
  function saveRegionStyle(item=selectedText){if(!item)return;const value=currentStyle(item.page,item.region),token=String(++saveSequence);editorStatus.textContent='กำลังบันทึก…';editor.dataset.saveToken=token;document.dispatchEvent(new CustomEvent('__harvestts_region_style_change',{detail:JSON.stringify({token,pageId:item.page.id,regionId:item.region.id,imageDigest:item.page.imageDigest,style:value})}));}
  editorText.addEventListener('input',()=>{if(!selectedText)return;setRegionStyle(selectedText.page.id,selectedText.region.id,mergedStyle(selectedText,{text:editorText.value}));editorStatus.textContent='กำลังแก้ข้อความ…';});
  editorText.addEventListener('change',()=>saveRegionStyle());
  editorText.addEventListener('blur',()=>{if(selectedText)saveRegionStyle();});
  editorEye.onclick=()=>{if(!selectedText)return;const on=setOriginalPreview(selectedText,!selectedText.previewOriginal);editorStatus.textContent=on?'กำลังดูต้นฉบับของกล่องนี้ • กด 👁 อีกครั้งเพื่อกลับคำแปล':'กลับมาแสดงคำแปลของกล่องนี้แล้ว';};
  fontRange.addEventListener('input',()=>{if(!selectedText)return;const css=Number(fontRange.value);fontValue.textContent=css+' px';setRegionStyle(selectedText.page.id,selectedText.region.id,mergedStyle(selectedText,{fontSizeImagePx:css/Math.max(.001,selectedText.imageScale||1)}));editorStatus.textContent=selectedText.text.dataset.fitWarning==='true'?'ข้อความใหญ่กว่ากรอบ — ขยายกรอบหรือลดตัวอักษรได้':'ขนาดนี้ใช้เฉพาะกล่องที่เลือก';});
  fontRange.addEventListener('change',()=>saveRegionStyle());resetFont.onclick=()=>{if(!selectedText)return;setRegionStyle(selectedText.page.id,selectedText.region.id,mergedStyle(selectedText,{},['fontSizeImagePx']));refresh();fontRange.value=selectedText.text.dataset.fontSize;fontValue.textContent=fontRange.value+' px';saveRegionStyle();};resetBox.onclick=()=>{if(!selectedText)return;setRegionStyle(selectedText.page.id,selectedText.region.id,mergedStyle(selectedText,{},['box']));saveRegionStyle();};editorClose.onclick=closeEditor;
  editor.addEventListener('click',e=>e.stopPropagation());editor.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Escape')closeEditor();});
  document.addEventListener('__harvestts_region_style_result',event=>{let r;try{r=JSON.parse(event.detail);}catch{return;}if(editor.dataset.saveToken!==r.token)return;editorStatus.textContent=r.ok?'บันทึกแล้ว • จำกรอบและขนาดไว้กับภาพนี้':'บันทึกไม่ได้: '+(r.error||'ไม่ทราบสาเหตุ');});
  const key=typeof documentKey==='function'?documentKey:url=>{try{const u=new URL(url,location.href);return u.origin+u.pathname+u.search+u.hash;}catch{return url;}};
  const svg=(tag,attrs={})=>{const node=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))node.setAttribute(k,String(v));return node;};
  const resize=new ResizeObserver(()=>schedule());
  function targets(page){
    if(page.source==='screenshot')return [document.documentElement];
    const matches=el=>[el.currentSrc,el.src,el.getAttribute?.('src')].filter(Boolean).some(url=>{try{return new URL(url,location.href).href===page.sourceUrl;}catch{return false;}});
    const images=Array.from(document.images).filter(matches);
    if(images.length||page.source!=='background')return images;
    return Array.from(document.body.querySelectorAll('*')).filter(el=>!host.contains(el)&&getComputedStyle(el).backgroundImage.includes(page.sourceUrl));
  }
  function geometry(el,page){
    if(page.source==='screenshot'){
      const c=page.capture||{},valid=innerWidth===c.viewportWidth&&innerHeight===c.viewportHeight&&Math.abs(devicePixelRatio-(c.devicePixelRatio||devicePixelRatio))<.01;
      return {left:(c.scrollX||0)-scrollX,top:(c.scrollY||0)-scrollY,width:valid?c.viewportWidth:0,height:valid?c.viewportHeight:0,drawW:c.viewportWidth,drawH:c.viewportHeight,x:0,y:0,fixed:false};
    }
    const rect=el.getBoundingClientRect(),css=getComputedStyle(el),sx=rect.width/Math.max(1,el.offsetWidth),sy=rect.height/Math.max(1,el.offsetHeight);
    const px=k=>(parseFloat(css[k])||0);
    const left=rect.left+(px('borderLeftWidth')+px('paddingLeft'))*sx,top=rect.top+(px('borderTopWidth')+px('paddingTop'))*sy;
    const width=rect.width-(px('borderLeftWidth')+px('borderRightWidth')+px('paddingLeft')+px('paddingRight'))*sx;
    const height=rect.height-(px('borderTopWidth')+px('borderBottomWidth')+px('paddingTop')+px('paddingBottom'))*sy;
    let drawW=width,drawH=height,pos=css.objectPosition,fit=css.objectFit;
    if(el.tagName!=='IMG'){fit=css.backgroundSize;pos=css.backgroundPosition;}
    if(['contain','cover','scale-down','none'].includes(fit)){
      let scale=fit==='cover'?Math.max(width/page.width,height/page.height):Math.min(width/page.width,height/page.height);
      if(fit==='none')scale=1;if(fit==='scale-down')scale=Math.min(1,scale);
      drawW=page.width*scale;drawH=page.height*scale;
    }else if(el.tagName!=='IMG'){
      const parts=fit.split(' '),dimension=(value,available,natural)=>value?.endsWith('%')?parseFloat(value)*available/100:value==='auto'||!value?natural:parseFloat(value);
      drawW=dimension(parts[0],width,page.width);drawH=dimension(parts[1],height,page.height);
      if(parts[0]!=='auto'&&(!parts[1]||parts[1]==='auto'))drawH=drawW*page.height/page.width;
      if(parts[0]==='auto'&&parts[1]&&parts[1]!=='auto')drawW=drawH*page.width/page.height;
    }
    const parts=(pos||'50% 50%').split(' '),offset=(value,extra)=>value?.endsWith('%')?parseFloat(value)*extra/100:({left:0,top:0,center:extra/2,right:extra,bottom:extra}[value]??(parseFloat(value)||0));
    let fixed=false;
    for(let node=el;node&&node!==document.documentElement;node=node.parentElement){
      if(getComputedStyle(node).position==='fixed'){fixed=true;break;}
    }
    return {left,top,width,height,drawW,drawH,x:offset(parts[0],width-drawW),y:offset(parts[1]||'50%',height-drawH),fixed};
  }
  function fitText(item,width,height,imageScale=1){
    const {text,span}=item;item.imageScale=imageScale;
    const padding=2*imageScale;text.style.padding=padding+'px';
    const availableW=Math.max(1,width-padding*2),availableH=Math.max(1,height-padding*2);
    const styleKey=styleKeyFor(item.page,item.region),manual=styleOverrides.has(styleKey)?styleOverrides.get(styleKey):item.region.userStyle,manualSize=Number(manual?.fontSizeImagePx);
    if(manualSize>0){const size=manualSize*imageScale;text.style.fontSize=size+'px';text.dataset.fontSize=size.toFixed(2);text.dataset.manualFont='true';text.dataset.fitWarning=String(span.scrollHeight>availableH+1||span.scrollWidth>availableW+1);return;}
    text.dataset.manualFont='false';
    // Font limits live in source-image pixels. A fixed CSS-pixel ceiling makes
    // translated text grow relative to the image when the reader zooms out.
    const reference=item.region.referenceLineHeight;let low=3*imageScale,high=(reference?Math.max(12,Math.min(28,reference*.95)):Math.max(14,Math.min(32,height/imageScale*.52)))*imageScale*fontScale,best=low;
    // `overflow-wrap:anywhere` hides mid-word breaks from overflow metrics.
    // Fit the longest language-aware word before optimizing line count.
    if(typeof Intl.Segmenter==='function'){
      let segmenter;try{segmenter=new Intl.Segmenter(item.page.targetLanguage||'th',{granularity:'word'});}catch{segmenter=new Intl.Segmenter(undefined,{granularity:'word'});}
      const words=[...segmenter.segment(span.textContent)].filter(s=>s.isWordLike).map(s=>s.segment);
      const ctx=document.createElement('canvas').getContext('2d'),computed=getComputedStyle(text);
      ctx.font=`${computed.fontWeight} 100px ${computed.fontFamily}`;
      const longest=Math.max(0,...words.map(word=>ctx.measureText(word).width));
      if(longest>0)high=Math.max(low,Math.min(high,availableW*100/longest));
    }
    text.style.fontSize=low+'px';
    for(let i=0;i<9;i++){const size=(low+high)/2;text.style.fontSize=size+'px';if(span.scrollHeight<=availableH+1&&span.scrollWidth<=availableW+1){best=size;low=size;}else high=size;}
    best=Math.floor(best*100)/100;text.style.fontSize=best.toFixed(2)+'px';
    for(let n=0;n<12&&(span.scrollHeight>availableH+1||span.scrollWidth>availableW+1)&&best>3*imageScale;n++){best=Math.max(3*imageScale,best-.02);text.style.fontSize=best.toFixed(2)+'px';}
    text.dataset.fontSize=best.toFixed(2);text.dataset.fitWarning=String(best/imageScale<8||span.scrollHeight>availableH+1||span.scrollWidth>availableW+1);
  }
  function mount(page,target){
    const frame=document.createElement('div');frame.className='frame';frame.dataset.pageId=page.id;
    const image=document.createElement('div');image.className='image';const mask=svg('svg',{viewBox:'0 0 1 1',preserveAspectRatio:'none'});mask.classList.add('mask');const defs=svg('defs');mask.append(defs);image.append(mask);frame.append(image);root.append(frame);
    const texts=[],paintTasks=[];let paintError='';const patches=document.createElement('div');patches.className='patches';image.append(patches);
    for(const [index,r] of page.regions.entries()){
      const group=svg('g'),paintNodes=[];
      if(r.erasePatch?.png){
        const c=document.createElement('canvas'),b=r.erasePatch.bbox;c.width=Math.max(1,Math.round((b.x1-b.x0)*page.width));c.height=Math.max(1,Math.round((b.y1-b.y0)*page.height));
        Object.assign(c.style,{left:b.x0*100+'%',top:b.y0*100+'%',width:(b.x1-b.x0)*100+'%',height:(b.y1-b.y0)*100+'%'});patches.append(c);paintNodes.push(c);
        const task=(async()=>{const bytes=Uint8Array.from(atob(r.erasePatch.png),ch=>ch.charCodeAt(0));const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));try{if(c.isConnected)c.getContext('2d').drawImage(bitmap,0,0,c.width,c.height);}finally{bitmap.close();}})().catch(error=>{paintError=error.message||String(error);});paintTasks.push(task);
      }
      if(r.polygon.length>=3){const clipId='clip-'+clipSequence++,clip=svg('clipPath',{id:clipId});clip.append(svg('polygon',{points:r.polygon.map(p=>p.join(',')).join(' ')}));defs.append(clip);group.setAttribute('clip-path',`url(#${clipId})`);}
      const b=r.eraseBox;if(r.paintMode!=='glyph-patch'){group.append(svg('rect',{x:b.x0,y:b.y0,width:b.x1-b.x0,height:b.y1-b.y0,fill:r.fillColor}));mask.append(group);paintNodes.push(group);
      for(const spill of r.eraseBoxes||[]){const spillNode=svg('rect',{x:spill.x0,y:spill.y0,width:spill.x1-spill.x0,height:spill.y1-spill.y0,fill:r.fillColor});mask.append(spillNode);paintNodes.push(spillNode);}}
      const text=document.createElement('div');text.className='text';text.dataset.regionId=r.id;text.lang=page.targetLanguage;text.title=r.original+'\n────────\n'+r.text;
      const color=r.fillColor.slice(1),luminance=parseInt(color.slice(0,2),16)*.2126+parseInt(color.slice(2,4),16)*.7152+parseInt(color.slice(4,6),16)*.0722;text.style.color=luminance<125?'#fff':'#151515';
      const span=document.createElement('span');span.textContent=effectiveText(page,r);text.append(span);text.title=r.original+'\n────────\n'+effectiveText(page,r);image.append(text);
      const item={text,span,region:r,page,paintNodes,previewOriginal:false,drawW:0,drawH:0,currentBox:null};texts.push(item);text.tabIndex=0;text.setAttribute('role','button');text.setAttribute('aria-label','ปรับกรอบคำแปล: '+r.text.slice(0,80));
      for(const dir of ['nw','n','ne','e','se','s','sw','w']){const handle=document.createElement('i');handle.className='resize-handle';handle.dataset.dir=dir;handle.setAttribute('aria-hidden','true');text.append(handle);}
      let press=null;
      const beginDrag=(e,dir='move')=>{if(!text.classList.contains('selected'))return;const b=effectiveBox(page,r);if(!validBox(b)||!(item.drawW>0&&item.drawH>0))return;e.preventDefault();e.stopPropagation();press={x:e.clientX,y:e.clientY,drag:true};text.setPointerCapture?.(e.pointerId);item.drag={pointerId:e.pointerId,dir,startX:e.clientX,startY:e.clientY,startBox:{...b},baseStyle:{...(currentStyle(page,r)||{})},moved:false};};
      text.addEventListener('pointerdown',e=>{if(e.target?.classList?.contains('resize-handle'))return;press={x:e.clientX,y:e.clientY};if(text.classList.contains('selected'))beginDrag(e,'move');});
      for(const handle of text.querySelectorAll('.resize-handle'))handle.addEventListener('pointerdown',e=>beginDrag(e,handle.dataset.dir));
      text.addEventListener('pointermove',e=>{const d=item.drag;if(!d||d.pointerId!==e.pointerId)return;const dx=(e.clientX-d.startX)/item.drawW,dy=(e.clientY-d.startY)/item.drawH,b={...d.startBox},minW=Math.max(.01,10/page.width),minH=Math.max(.01,10/page.height);if(Math.abs(e.clientX-d.startX)+Math.abs(e.clientY-d.startY)>2)d.moved=true;if(d.dir==='move'){const w=b.x1-b.x0,h=b.y1-b.y0;b.x0=Math.max(0,Math.min(1-w,d.startBox.x0+dx));b.y0=Math.max(0,Math.min(1-h,d.startBox.y0+dy));b.x1=b.x0+w;b.y1=b.y0+h;}else{if(d.dir.includes('w'))b.x0=Math.max(0,Math.min(b.x1-minW,d.startBox.x0+dx));if(d.dir.includes('e'))b.x1=Math.min(1,Math.max(b.x0+minW,d.startBox.x1+dx));if(d.dir.includes('n'))b.y0=Math.max(0,Math.min(b.y1-minH,d.startBox.y0+dy));if(d.dir.includes('s'))b.y1=Math.min(1,Math.max(b.y0+minH,d.startBox.y1+dy));}if(setRegionStyle(page.id,r.id,{...d.baseStyle,box:b}))editorStatus.textContent='กำลังปรับกรอบ…';});
      const endDrag=e=>{const d=item.drag;if(!d||d.pointerId!==e.pointerId)return;item.drag=null;text.releasePointerCapture?.(e.pointerId);if(d.moved){press=null;saveRegionStyle(item);editorStatus.textContent='บันทึกตำแหน่งกรอบแล้ว';}};
      text.addEventListener('pointerup',endDrag);text.addEventListener('pointercancel',endDrag);
      text.addEventListener('click',e=>{e.stopPropagation();if(item.drag)return;if(!press||Math.hypot(e.clientX-press.x,e.clientY-press.y)<8)openEditor(item);press=null;});
      text.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();openEditor(item);}});
    }
    const entry={page,target,frame,image,texts,lastSize:'',paintReady:paintTasks.length===0,paintError:''};entry.paintPromise=Promise.all(paintTasks).then(()=>{entry.paintReady=true;entry.paintError=paintError;schedule();});entries.push(entry);resize.observe(target);
  }
  function refresh(){
    scheduled=0;
    if(host.style.display==='none')return {drawn:Number(host.dataset.regions)||0,total:Number(host.dataset.total)||0,visible};
    if(expectedUrl&&key(location.href)!==expectedUrl){clear();return {drawn:0,total:0,visible,reason:'document-changed'};}
    if(dirty){
      const matches=new Map([...pages.values()].map(page=>[page.id,targets(page).filter(target=>target.tagName!=='IMG'||target.complete&&target.naturalWidth)]));
      for(let i=entries.length-1;i>=0;i--){const e=entries[i];if(pages.get(e.page.id)!==e.page||!matches.get(e.page.id)?.includes(e.target)){resize.unobserve(e.target);e.frame.remove();entries.splice(i,1);}}
      for(const page of pages.values())for(const target of matches.get(page.id))if(!entries.some(e=>e.page===page&&e.target===target))mount(page,target);
      dirty=false;
    }
    let drawn=0,warnings=0,captureMismatch=false;
    for(const entry of entries){
      const g=geometry(entry.target,entry.page);const okay=entry.paintReady&&!entry.paintError&&entry.target.isConnected&&g.width>0&&g.height>0&&getComputedStyle(entry.target).visibility!=='hidden';
      entry.frame.style.display=visible&&okay?'block':'none';if(!okay){if(entry.page.source==='screenshot')captureMismatch=true;continue;}drawn+=entry.texts.length;
      const frameLeft=g.fixed?g.left:g.left+scrollX,frameTop=g.fixed?g.top:g.top+scrollY;
      Object.assign(entry.frame.style,{position:g.fixed?'fixed':'absolute',left:frameLeft+'px',top:frameTop+'px',width:g.width+'px',height:g.height+'px'});
      Object.assign(entry.image.style,{left:g.x+'px',top:g.y+'px',width:g.drawW+'px',height:g.drawH+'px'});
      const size=[g.drawW,g.drawH,fontScale,styleRevision].join('/');
      if(!visible)entry.lastSize='';
      else if(entry.lastSize!==size){for(const item of entry.texts){const b=effectiveBox(item.page,item.region),w=(b.x1-b.x0)*g.drawW,h=(b.y1-b.y0)*g.drawH;item.drawW=g.drawW;item.drawH=g.drawH;item.currentBox={...b};const rotated=item.region.rotatedTextBox,scale=g.drawH/entry.page.height;if(rotated&&!currentStyle(item.page,item.region)?.box){const rw=rotated.width*scale,rh=rotated.height*scale;Object.assign(item.text.style,{left:rotated.cx*scale-rw/2+'px',top:rotated.cy*scale-rh/2+'px',width:rw+'px',height:rh+'px',transform:'rotate('+rotated.angle+'deg)',transformOrigin:'center'});fitText(item,rw,rh,scale);}else{Object.assign(item.text.style,{left:b.x0*g.drawW+'px',top:b.y0*g.drawH+'px',width:w+'px',height:h+'px',transform:''});fitText(item,w,h,scale);}}entry.lastSize=size;}
      warnings+=entry.texts.filter(t=>t.text.dataset.fitWarning==='true').length;
    }
    const total=[...pages.values()].reduce((n,p)=>n+p.regions.length,0);host.dataset.regions=String(drawn);host.dataset.total=String(total);host.dataset.fitWarnings=String(warnings);host.dataset.visible=String(visible);
    controls.hidden=!total;controls.style.display=total?'flex':'none';toggle.textContent=visible?'ดูต้นฉบับ':'ดูคำแปล';const review=[...pages.values()].reduce((n,p)=>n+(p.reviewCount||0),0);label.textContent=`แสดงคำแปล ${drawn} จุด`+(review?' • รอตรวจ '+review+' จุด':'')+(captureMismatch?' • ขนาดหน้าเปลี่ยน จับภาพใหม่':warnings?' • บางกรอบตัวเล็ก':'');
    const pageStates=[...pages.values()].map(page=>{const matching=entries.filter(e=>e.page===page),ready=matching.filter(e=>e.paintReady&&!e.paintError&&e.target.isConnected);return {id:page.id,total:page.regions.length,drawn:ready.reduce((n,e)=>n+e.texts.length,0),targets:matching.length};});
    return {drawn,total,visible,fitWarnings:warnings,pages:pageStates};
  }
  function schedule(rebind=false){dirty=dirty||rebind;if(!scheduled)scheduled=requestAnimationFrame(refresh);}
  function clear(){closeEditor();pages.clear();dirty=true;expectedUrl='';refresh();}
  function apply(page,options={}){
    const requested=key(page.documentUrl||location.href);
    if(requested!==key(location.href))return {drawn:0,total:0,pageDrawn:0,pageTotal:page.regions.length,error:'document-changed'};
    if(expectedUrl&&expectedUrl!==requested)clear();
    expectedUrl=requested;pages.set(page.id,page);visible=typeof options.visible==='boolean'?options.visible:true;fontScale=Number(options.fontScale)||fontScale;dirty=true;
    const result=refresh(),state=result.pages?.find(p=>p.id===page.id);
    return {...result,pageDrawn:state?.drawn||0,pageTotal:page.regions.length,pending:page.regions.length>0&&!state?.drawn};
  }
  function setVisible(value){visible=Boolean(value);if(!visible)closeEditor();return refresh();}
  function settings(value){fontScale=Math.max(.7,Math.min(1.8,Number(value.fontScale)||1));schedule();}
  toggle.onclick=()=>setVisible(!visible);
  const observer=new MutationObserver(records=>{if(records.some(r=>!host.contains(r.target)))schedule(true);});observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['src','srcset','style','class','hidden']});
  addEventListener('scroll',()=>schedule(),true);addEventListener('resize',()=>schedule(true));addEventListener('load',event=>{if(event.target.tagName==='IMG')schedule(true);},true);
  addEventListener('popstate',()=>schedule(true));addEventListener('hashchange',()=>schedule());document.fonts?.ready.then(()=>{for(const e of entries)e.lastSize='';schedule();});
  const timer=setInterval(()=>schedule(),750);
  addEventListener('pagehide',()=>{clearInterval(timer);observer.disconnect();resize.disconnect();},{once:true});
  async function whenReady(pageId){await Promise.all(entries.filter(e=>!pageId||e.page.id===pageId).map(e=>e.paintPromise));const failed=entries.find(e=>(!pageId||e.page.id===pageId)&&e.paintError);if(failed)throw Error('วาดภาพคลีนไม่ได้: '+failed.paintError);const result=refresh(),state=result.pages?.find(p=>p.id===pageId);return {...result,pageDrawn:state?.drawn||0,pageTotal:state?.total||0,pending:Boolean(state?.total&&!state.drawn)};}
  return {apply,clear,setVisible,settings,setRegionStyle,stats:refresh,whenReady};
}
module.exports={overlayPage,createTranslationOverlay};
